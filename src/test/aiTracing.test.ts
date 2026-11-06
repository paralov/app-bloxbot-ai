import { describe, expect, it, vi } from "vitest";
import { AiTracer, toConversation, trimConversation, truncateText } from "@/lib/aiTracing";
import type { Event } from "@/lib/opencode/types";
import type { MessageWithParts } from "@/types";
import type { InstructionFile } from "@/types/desktop";

const studio = {
  placeId: "123456",
  placeName: "Obby",
  discoveredPlaceIds: ["123456", "789"],
  discoveredCount: 2,
};

function setup() {
  let now = 1_000;
  const capture = vi.fn();
  const tracer = new AiTracer(
    capture,
    () => studio,
    () => now,
  );
  const send = (type: string, properties: unknown) =>
    tracer.handleEvent({ type, properties } as unknown as Event);
  return {
    capture,
    tracer,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    events: (name: string) =>
      capture.mock.calls.filter(([event]) => event === name).map(([, props]) => props),
  };
}

function userMessage(id = "msg_user", sessionID = "ses_1", created = 1_000) {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "studio",
    model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    system: "Route Studio calls to studio_id abc.",
  };
}

function assistantMessage(
  overrides: { id?: string; sessionID?: string; parentID?: string; created?: number } = {},
  completed?: number,
) {
  return {
    id: overrides.id ?? "msg_assistant",
    sessionID: overrides.sessionID ?? "ses_1",
    role: "assistant",
    parentID: overrides.parentID ?? "msg_user",
    time: { created: overrides.created ?? 1_100, completed },
    providerID: "anthropic",
    modelID: "claude-sonnet-5",
    mode: "studio",
    agent: "studio",
    path: { cwd: "/", root: "/" },
    cost: 0.01,
    tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 50, write: 0 } },
    finish: "stop",
  };
}

function textPart(id: string, messageID: string, text: string, sessionID = "ses_1") {
  return { id, sessionID, messageID, type: "text", text };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AI tracing", () => {
  it("drops buffered data on opt-out and ignores activity while opted out", () => {
    let enabled = true;
    const capture = vi.fn();
    const tracer = new AiTracer(
      capture,
      () => null,
      Date.now,
      () => enabled,
    );
    const send = (type: string, properties: unknown) =>
      tracer.handleEvent({ type, properties } as unknown as Event);

    tracer.beginTurn({ sessionID: "ses_1", text: "private", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    enabled = false;
    tracer.reset();
    tracer.beginTurn({ sessionID: "ses_1", text: "also private", imageCount: 0 });
    send("message.updated", { info: assistantMessage({}, 1_200) });
    enabled = true;
    send("session.idle", { sessionID: "ses_1" });

    expect(capture).not.toHaveBeenCalled();
  });

  it("does not upload instruction files for a prompt that failed to send", async () => {
    const { tracer, events } = setup();
    let resolveFiles: (files: InstructionFile[]) => void = () => {};
    tracer.configure({
      loadInstructions: () =>
        new Promise((resolve) => {
          resolveFiles = resolve;
        }),
    });

    tracer.beginTurn({ sessionID: "ses_1", text: "offline", imageCount: 0 });
    tracer.cancelTurn("ses_1");
    resolveFiles([{ path: "~/AGENTS.md", scope: "project", chars: 1, content: "x" }]);
    await flush();

    expect(events("ai_instructions")).toHaveLength(0);
  });

  it("keeps attachments out and trims oversized conversations from the oldest end", () => {
    const conversation = toConversation([
      {
        info: userMessage() as never,
        parts: [
          textPart("p1", "msg_user", "look"),
          { id: "p2", type: "file", mime: "image/png", filename: "shot.png", url: "data:..." },
        ] as never,
      },
    ] satisfies MessageWithParts[]);
    expect(conversation[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[attachment: shot.png (image/png)]" },
      ],
    });

    const long = Array.from({ length: 5 }, (_, index) => ({
      role: "user" as const,
      content: `message ${index} ${"x".repeat(50)}`,
    }));
    const trimmed = trimConversation(long, 200);
    expect(trimmed[0]).toEqual({
      role: "system",
      content: "[3 earlier messages omitted from analytics]",
    });
    expect(trimmed.slice(1)).toEqual(long.slice(3));
    expect(truncateText("abcdef", 3)).toBe("abc… [truncated 3 chars]");
  });
});

describe("failed replies", () => {
  it("sends an error's status, reset delay and OpenCode reason on their own", () => {
    const { tracer, send, events } = setup();
    const error = {
      name: "APIError",
      data: {
        message: "Free usage limit reached.",
        type: "provider.free-limit",
        statusCode: 429,
        retryAfterMs: 3_600_000,
        isRetryable: false,
      },
    };

    tracer.beginTurn({ sessionID: "ses_1", text: "build it", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    send("session.error", { sessionID: "ses_1", error });
    send("message.updated", { info: { ...assistantMessage({}, 1_200), error } });
    send("session.idle", { sessionID: "ses_1" });

    const details = {
      error_name: "APIError",
      ai_error_status: 429,
      ai_error_retry_after_ms: 3_600_000,
      ai_error_type: "provider.free-limit",
    };
    expect(events("$ai_generation")[0]).toMatchObject({ $ai_is_error: true, ...details });
    expect(events("$ai_trace")[0]).toMatchObject({ $ai_is_error: true, ...details });
  });

  it("leaves them out when OpenCode doesn't pass them on", () => {
    const { tracer, send, events } = setup();
    const error = { name: "UnknownError", data: { message: "Free usage limit reached." } };

    tracer.beginTurn({ sessionID: "ses_1", text: "build it", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    send("message.updated", { info: { ...assistantMessage({}, 1_200), error } });

    const generation = events("$ai_generation")[0] as Record<string, unknown>;
    expect(generation.error_name).toBe("UnknownError");
    expect(generation.ai_error_status).toBeUndefined();
    expect(generation.ai_error_retry_after_ms).toBeUndefined();
  });
});

describe("streamed text", () => {
  it("doesn't edit the event's part, which the message cache and the screen share", () => {
    const tracer = new AiTracer(() => {});
    const part = {
      id: "part-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "text",
      text: "",
    } as const;
    const shared = { ...part };

    tracer.handleEvent({
      type: "message.updated",
      properties: {
        sessionID: "session-1",
        info: {
          id: "message-1",
          sessionID: "session-1",
          role: "assistant",
          time: { created: 1 },
          parentID: "user-1",
          modelID: "model",
          providerID: "provider",
          mode: "studio",
          agent: "studio",
          path: { cwd: "", root: "" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    });
    tracer.handleEvent({
      type: "message.part.updated",
      properties: { sessionID: "session-1", part: shared, time: 1 },
    });
    tracer.handleEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "session-1",
        messageID: "message-1",
        partID: "part-1",
        field: "text",
        delta: "Hello",
      },
    });

    expect(shared.text).toBe("");
  });
});
