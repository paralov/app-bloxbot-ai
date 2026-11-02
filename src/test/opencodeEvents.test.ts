import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it } from "vitest";

import { EventTranslator } from "@/lib/opencode/events";
import {
  historyToMessages,
  todosFromHistory,
  toFormAnswer,
  toModelError,
  toQuestionRequest,
} from "@/lib/opencode/messages";

const sessionID = "ses_1";
const assistantMessageID = "msg_2";
const model = { id: "beam-free", providerID: "opencode", variant: "default" };
const tokens = { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } };

const event = (type: string, data: object, created = 100) =>
  ({ id: `evt_${type}`, created, type, data }) as unknown as OpenCodeEvent;

function translate(...events: OpenCodeEvent[]) {
  const translator = new EventTranslator();
  return events.flatMap((item) => translator.translate(item));
}

const turnStart = [
  event("session.inbox.enqueued", {
    inboxID: "msg_1",
    sessionID,
    item: { type: "user", payload: { text: "Hello" } },
  }),
  event("session.step.started", {
    sessionID,
    assistantMessageID,
    agent: "studio",
    model,
    started: 100,
  }),
];

describe("EventTranslator", () => {
  it("turns a prompt into a user message with its text", () => {
    const [message, part] = translate(turnStart[0] as OpenCodeEvent);
    expect(message).toMatchObject({
      type: "message.updated",
      properties: { info: { id: "msg_1", role: "user" } },
    });
    expect(part).toMatchObject({
      type: "message.part.updated",
      properties: { part: { messageID: "msg_1", type: "text", text: "Hello" } },
    });
  });

  it("links an assistant message to the prompt that started it", () => {
    const [, , message] = translate(...turnStart);
    expect(message).toMatchObject({
      type: "message.updated",
      properties: {
        info: {
          id: assistantMessageID,
          role: "assistant",
          parentID: "msg_1",
          modelID: "beam-free",
        },
      },
    });
  });

  it("streams text as deltas on a part, then settles on the final text", () => {
    const ids = { sessionID, assistantMessageID, ordinal: 0 };
    const events = translate(
      ...turnStart,
      event("session.text.started", ids),
      event("session.text.delta", { ...ids, delta: "O" }),
      event("session.text.ended", { ...ids, text: "OK" }),
    );
    const [started, delta, ended] = events.slice(-3);
    const partID = `${assistantMessageID}:text:0`;
    expect(started).toMatchObject({ properties: { part: { id: partID, text: "" } } });
    expect(delta).toMatchObject({
      type: "message.part.delta",
      properties: { partID, field: "text", delta: "O" },
    });
    expect(ended).toMatchObject({ properties: { part: { id: partID, text: "OK" } } });
  });

  it("completes the assistant message when its step ends, for usage reporting", () => {
    const events = translate(
      ...turnStart,
      event(
        "session.step.ended",
        { sessionID, assistantMessageID, finish: "stop", cost: 0, tokens },
        200,
      ),
    );
    expect(events.at(-2)).toMatchObject({
      type: "message.updated",
      properties: { info: { time: { completed: 200 }, tokens, finish: "stop" } },
    });
  });

  it("follows a tool from its input through to the result under the UI's names", () => {
    const ids = { sessionID, assistantMessageID, id: "call_1" };
    const events = translate(
      ...turnStart,
      event("session.tool.input.started", { ...ids, name: "shell" }, 110),
      event("session.tool.called", { ...ids, input: { command: "echo hi" }, executed: false }, 120),
      event(
        "session.tool.success",
        { ...ids, content: [{ type: "text", text: "hi\n" }], executed: false },
        130,
      ),
    );
    const [pending, running, completed] = events.slice(-3);
    expect(pending).toMatchObject({
      properties: { part: { tool: "bash", state: { status: "pending" } } },
    });
    expect(running).toMatchObject({
      properties: { part: { tool: "bash", state: { status: "running" } } },
    });
    expect(completed).toMatchObject({
      properties: {
        part: {
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo hi" },
            output: "hi\n",
            time: { start: 120, end: 130 },
          },
        },
      },
    });
  });

  it("reports todos when the todo tool succeeds", () => {
    const ids = { sessionID, assistantMessageID, id: "call_2" };
    const todos = [{ content: "Check", status: "pending" }];
    const events = translate(
      ...turnStart,
      event("session.tool.input.started", { ...ids, name: "todowrite" }),
      event("session.tool.called", { ...ids, input: { todos }, executed: false }),
      event("session.tool.success", {
        ...ids,
        content: [{ type: "text", text: "Updated" }],
        metadata: { todos },
        executed: false,
      }),
    );
    expect(events.at(-1)).toEqual({
      type: "todo.updated",
      properties: {
        sessionID,
        todos: [{ content: "Check", status: "pending", priority: "medium" }],
      },
    });
  });

  it("marks a chat busy, then idle, around a turn", () => {
    expect(
      translate(
        event("session.execution.started", { sessionID }),
        event("session.execution.succeeded", { sessionID }),
      ).map((item) => (item.type === "session.status" ? item.properties.status.type : item.type)),
    ).toEqual(["busy", "idle", "session.idle"]);
  });

  it("reports the reason before going idle when a turn fails, so nothing says it finished", () => {
    const error = { type: "provider.rate_limit", message: "Free usage limit reached", status: 429 };
    const [failure, status, idle] = translate(
      event("session.execution.failed", { sessionID, error }),
    );
    expect(failure).toMatchObject({
      type: "session.error",
      properties: { error: { data: { message: "Free usage limit reached", statusCode: 429 } } },
    });
    expect(status).toMatchObject({ properties: { status: { type: "idle" } } });
    expect(idle?.type).toBe("session.idle");
  });

  it("reports a stopped turn as aborted rather than as a problem", () => {
    const [failure] = translate(
      event("session.execution.interrupted", { sessionID, reason: "user" }),
    );
    expect(failure).toMatchObject({
      type: "session.error",
      properties: { error: { name: "MessageAbortedError" } },
    });
  });

  it("shows retries with their reason and next attempt", () => {
    const [status] = translate(
      event("session.retry.scheduled", {
        sessionID,
        assistantMessageID,
        attempt: 2,
        at: 500,
        error: { type: "provider", message: "Overloaded" },
      }),
    );
    expect(status).toMatchObject({
      properties: { status: { type: "retry", attempt: 2, message: "Overloaded", next: 500 } },
    });
  });

  it("renames, archives and restores a chat it knows about", () => {
    const translator = new EventTranslator();
    translator.translate(
      event("session.created", {
        sessionID,
        projectID: "prj",
        location: { directory: "/w" },
        slug: "s",
        version: "2",
      }),
    );
    expect(
      translator.translate(event("session.renamed", { sessionID, title: "New name" }))[0],
    ).toMatchObject({ type: "session.updated", properties: { info: { title: "New name" } } });
    expect(translator.translate(event("session.archived", { sessionID }))[0]).toMatchObject({
      properties: { info: { time: { archived: 100 } } },
    });
    const restored = translator.translate(event("session.unarchived", { sessionID }))[0];
    expect(restored?.type === "session.updated" && restored.properties.info.time.archived).toBe(
      undefined,
    );
  });

  it("carries the hidden flag on new chats, which is how helper chats stay out of the list", () => {
    const [created] = translate(
      event("session.created", {
        sessionID,
        projectID: "prj",
        location: { directory: "/w" },
        slug: "s",
        version: "2",
        metadata: { bloxbotHidden: true },
      }),
    );
    expect(created).toMatchObject({
      properties: { info: { metadata: { bloxbotHidden: true } } },
    });
  });

  it("uses the established permission names", () => {
    const [asked] = translate(
      event("permission.asked", {
        id: "per_1",
        sessionID,
        action: "shell",
        resources: ["echo hi"],
        save: ["echo *"],
      }),
    );
    expect(asked).toMatchObject({
      type: "permission.asked",
      properties: { permission: "bash", patterns: ["echo hi"], always: ["echo *"] },
    });
  });
});

const form = {
  id: "frm_1",
  sessionID,
  title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_2", id: "call_1" } },
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Colour",
      description: "Which colour?",
      options: [
        { value: "r", label: "Red", description: "Warm" },
        { value: "b", label: "Blue" },
      ],
      custom: true,
    },
    {
      key: "q1",
      type: "multiselect",
      title: "Sizes",
      options: [
        { value: "s", label: "Small" },
        { value: "l", label: "Large" },
      ],
    },
  ],
} as never;

describe("questions", () => {
  it("presents each form field as a question", () => {
    expect(toQuestionRequest(form)).toMatchObject({
      id: "frm_1",
      questions: [
        {
          header: "Colour",
          question: "Which colour?",
          options: [{ label: "Red", description: "Warm" }, { label: "Blue" }],
          multiple: false,
        },
        { header: "Sizes", multiple: true },
      ],
      tool: { messageID: "msg_2", callID: "call_1" },
    });
  });

  it("answers with the values the form offered, and keeps typed answers as they are", () => {
    expect(toFormAnswer(form, [["Blue"], ["Small", "Large"]])).toEqual({
      q0: "b",
      q1: ["s", "l"],
    });
    expect(toFormAnswer(form, [["Teal"], []])).toEqual({ q0: "Teal", q1: [] });
  });
});

describe("history", () => {
  const history = [
    { id: "msg_1", type: "user", text: "Hi", time: { created: 1 } },
    {
      id: "msg_2",
      type: "assistant",
      agent: "studio",
      model,
      time: { created: 2, completed: 3 },
      content: [
        { type: "reasoning", text: "Thinking" },
        {
          type: "tool",
          id: "call_1",
          name: "write",
          state: {
            status: "completed",
            input: { path: "/w/a.txt", content: "hi" },
            content: [{ type: "text", text: "Done" }],
            metadata: { todos: [] },
          },
          time: { created: 2, ran: 2, completed: 3 },
        },
        { type: "text", text: "Finished" },
      ],
      tokens,
      cost: 0,
    },
    { id: "msg_3", type: "idle", outcome: "succeeded", time: { created: 4 } },
    { id: "msg_4", type: "model-switched", time: { created: 5 } },
  ] as never;

  it("keeps the messages the chat shows, linked and in order", () => {
    const messages = historyToMessages(sessionID, history);
    expect(messages.map((message) => message.info.id)).toEqual(["msg_1", "msg_2"]);
    expect(messages[1]?.info).toMatchObject({ role: "assistant", parentID: "msg_1" });
    expect(messages[1]?.parts.map((part) => part.type)).toEqual(["reasoning", "tool", "text"]);
  });

  it("gives parts the same ids as the live stream, so a refetch can't duplicate them", () => {
    const parts = historyToMessages(sessionID, history)[1]?.parts;
    expect(parts?.map((part) => part.id)).toEqual(["msg_2:reasoning:0", "call_1", "msg_2:text:0"]);
  });

  it("gives file tools the path under the field the tool views read", () => {
    const tool = historyToMessages(sessionID, history)[1]?.parts[1];
    expect(tool?.type === "tool" && tool.state.input.filePath).toBe("/w/a.txt");
  });

  it("finds the latest todos", () => {
    const todos = [{ content: "Later", status: "completed" }];
    expect(
      todosFromHistory([
        {
          id: "m",
          type: "assistant",
          content: [
            {
              type: "tool",
              name: "todowrite",
              state: { status: "completed", metadata: { todos } },
            },
          ],
        },
      ] as never),
    ).toEqual([{ content: "Later", status: "completed", priority: "medium" }]);
  });
});

describe("toModelError", () => {
  it("maps what the UI treats differently", () => {
    expect(toModelError({ type: "provider.auth", message: "Bad key" }).name).toBe(
      "ProviderAuthError",
    );
    expect(toModelError({ type: "context_overflow", message: "Too long" }).name).toBe(
      "ContextOverflowError",
    );
    expect(toModelError({ type: "provider", message: "Nope", status: 500 }).name).toBe("APIError");
  });
});
