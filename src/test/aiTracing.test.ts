import type { Event } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";
import { AiTracer, toConversation, trimConversation, truncateText } from "@/lib/aiTracing";
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
  it("captures a trace with its generation, reasoning, tool span, timings, and Studio place", async () => {
    const { tracer, send, advance, events } = setup();
    tracer.configure({
      loadHistory: async () => [
        {
          info: { ...userMessage("msg_old", "ses_1", 10), system: undefined } as never,
          parts: [textPart("prt_old", "msg_old", "Earlier question")] as never,
        },
      ],
      loadTools: async () => [
        { id: "roblox-studio_run_code", description: "Run Luau", parameters: { type: "object" } },
      ],
    });

    tracer.beginTurn({
      sessionID: "ses_1",
      text: "Make the lava part red",
      imageCount: 0,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    await flush();
    send("session.updated", { info: { id: "ses_1", title: "Lava colors" } });
    send("message.updated", { info: userMessage() });
    send("message.part.updated", {
      part: textPart("prt_prompt", "msg_user", "Make the lava part red"),
    });
    send("message.updated", { info: assistantMessage() });
    advance(300);
    send("message.part.updated", {
      part: {
        id: "prt_reasoning",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "reasoning",
        text: "Find the lava part",
        time: { start: 1_300 },
      },
    });
    send("message.part.updated", { part: textPart("prt_text", "msg_assistant", "Done") });
    send("message.part.delta", {
      sessionID: "ses_1",
      messageID: "msg_assistant",
      partID: "prt_text",
      field: "text",
      delta: ", the lava is red.",
    });
    send("message.part.updated", {
      part: {
        id: "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "roblox-studio_run_code",
        state: {
          status: "completed",
          input: { studio_id: "abc", code: "print(1)" },
          output: "1",
          title: "run_code",
          metadata: {},
          time: { start: 1_200, end: 1_450 },
        },
      },
    });
    send("message.updated", { info: assistantMessage({}, 2_000) });
    send("todo.updated", {
      sessionID: "ses_1",
      todos: [{ content: "Recolor lava", status: "completed", priority: "high" }],
    });
    send("session.diff", {
      sessionID: "ses_1",
      diff: [{ file: "Lava.luau", additions: 2, deletions: 1, status: "modified" }],
    });
    advance(1_700);
    send("session.status", { sessionID: "ses_1", status: { type: "idle" } });
    send("session.idle", { sessionID: "ses_1" });

    expect(events("$ai_span")).toEqual([
      expect.objectContaining({
        $ai_trace_id: "msg_user",
        $ai_parent_id: "msg_assistant",
        $ai_span_name: "roblox-studio_run_code",
        $ai_input_state: { studio_id: "abc", code: "print(1)" },
        $ai_output_state: "1",
        $ai_latency: 0.25,
        studio_tool: true,
        roblox_place_id: "123456",
      }),
    ]);
    const [generation] = events("$ai_generation");
    expect(generation).toMatchObject({
      $ai_trace_id: "msg_user",
      $ai_session_id: "ses_1",
      $ai_model: "claude-sonnet-5",
      $ai_input: [
        { role: "user", content: [{ type: "text", text: "Earlier question" }] },
        { role: "system", content: "Route Studio calls to studio_id abc." },
        { role: "user", content: [{ type: "text", text: "Make the lava part red" }] },
      ],
      $ai_output_choices: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Find the lava part" },
            { type: "text", text: "Done, the lava is red." },
            { type: "tool_use", id: "call_1", name: "roblox-studio_run_code" },
          ],
        },
      ],
      $ai_tools: [{ name: "roblox-studio_run_code", description: "Run Luau" }],
      $ai_input_tokens: 150,
      $ai_output_tokens: 50,
      $ai_latency: 0.9,
      $ai_time_to_first_token: 0.2,
      reasoning_chars: 18,
    });
    expect(events("$ai_trace")).toEqual([
      expect.objectContaining({
        $ai_trace_id: "msg_user",
        $ai_span_name: "Lava colors",
        $ai_latency: 2,
        wall_time_ms: 2_000,
        time_to_first_output_ms: 300,
        generation_count: 1,
        tool_call_count: 1,
        studio_tool_call_count: 1,
        tools_used: ["roblox-studio_run_code"],
        todos: [{ content: "Recolor lava", status: "completed", priority: "high" }],
        session_files_changed_count: 1,
        session_lines_added: 2,
        $ai_output_state: [{ role: "assistant", content: "Done, the lava is red." }],
        roblox_place_id: "123456",
        roblox_place_name: "Obby",
        roblox_discovered_place_ids: ["123456", "789"],
      }),
    ]);
  });

  it("sends instruction files once and references them by id", async () => {
    const { tracer, send, events } = setup();
    const files = [
      { path: "~/BloxBot/AGENTS.md", scope: "project" as const, chars: 5, content: "Use Luau" },
    ];
    tracer.configure({ loadInstructions: async () => files });

    for (const id of ["msg_a", "msg_b"]) {
      tracer.beginTurn({ sessionID: "ses_1", text: "hi", imageCount: 0 });
      await flush();
      send("message.updated", { info: userMessage(id) });
      send("message.updated", {
        info: assistantMessage({ id: `${id}_reply`, parentID: id }, 1_200),
      });
      send("session.idle", { sessionID: "ses_1" });
    }

    const [snapshot] = events("ai_instructions");
    expect(events("ai_instructions")).toHaveLength(1);
    expect(snapshot).toMatchObject({
      instruction_files: files,
      instruction_file_count: 1,
      roblox_place_id: "123456",
    });
    const generations = events("$ai_generation");
    expect(generations.map((generation) => generation.instructions_id)).toEqual([
      snapshot.instructions_id,
      snapshot.instructions_id,
    ]);
    expect(generations[0].$ai_input[0]).toEqual({
      role: "system",
      content: `[User instructions ${snapshot.instructions_id}: ~/BloxBot/AGENTS.md]`,
    });
    expect(events("$ai_trace")[0]).toMatchObject({ instructions_id: snapshot.instructions_id });
  });

  it("feeds earlier tool results into the next generation's input", () => {
    const { tracer, send, events } = setup();
    tracer.beginTurn({ sessionID: "ses_1", text: "go", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    send("message.part.updated", { part: textPart("prt_prompt", "msg_user", "go") });
    send("message.updated", { info: assistantMessage() });
    send("message.part.updated", {
      part: {
        id: "prt_tool",
        sessionID: "ses_1",
        messageID: "msg_assistant",
        type: "tool",
        callID: "call_1",
        tool: "read",
        state: {
          status: "error",
          input: { path: "x" },
          error: "missing",
          time: { start: 1, end: 2 },
        },
      },
    });
    send("message.updated", { info: assistantMessage({}, 1_200) });
    send("message.updated", {
      info: assistantMessage({ id: "msg_second", created: 1_300 }, 1_400),
    });

    expect(events("$ai_generation")[1].$ai_input).toEqual([
      { role: "system", content: "Route Studio calls to studio_id abc." },
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "x" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "missing", is_error: true },
        ],
      },
    ]);
  });

  it("nests sub-agent sessions, permission prompts, and retries under the prompt's trace", () => {
    const { tracer, send, advance, events } = setup();
    tracer.beginTurn({ sessionID: "ses_1", text: "delegate", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    send("session.created", { info: { id: "ses_child", parentID: "ses_1", title: "Explore" } });
    send("message.updated", { info: userMessage("msg_child_user", "ses_child", 1_050) });
    send("message.part.updated", {
      part: textPart("prt_child", "msg_child_user", "Look around", "ses_child"),
    });
    send("message.updated", {
      info: assistantMessage(
        { id: "msg_child", sessionID: "ses_child", parentID: "msg_child_user", created: 1_060 },
        1_500,
      ),
    });
    send("permission.asked", {
      id: "per_1",
      sessionID: "ses_1",
      permission: "edit",
      patterns: ["*.luau"],
      metadata: {},
      always: [],
    });
    advance(4_000);
    send("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" });
    send("session.status", {
      sessionID: "ses_1",
      status: { type: "retry", attempt: 1, message: "Overloaded", next: 9_000 },
    });
    send("session.status", {
      sessionID: "ses_1",
      status: { type: "retry", attempt: 1, message: "Overloaded", next: 9_000 },
    });
    send("session.idle", { sessionID: "ses_child" });
    send("session.idle", { sessionID: "ses_1" });

    expect(events("$ai_generation")[0]).toMatchObject({
      $ai_trace_id: "msg_user",
      $ai_session_id: "ses_1",
      $ai_parent_id: "ses_child",
      subagent: true,
    });
    const spans = events("$ai_span");
    expect(spans.map((span) => span.$ai_span_name)).toEqual([
      "permission:edit",
      "retry",
      "subagent:studio",
    ]);
    expect(spans[0]).toMatchObject({
      $ai_latency: 4,
      $ai_output_state: "once",
      user_wait_ms: 4_000,
    });
    expect(spans[2]).toMatchObject({ $ai_span_id: "ses_child", $ai_input_state: "Look around" });
    expect(events("$ai_trace")[0]).toMatchObject({
      permission_count: 1,
      retry_count: 1,
      subagent_count: 1,
      user_wait_ms: 4_000,
    });
  });

  it("holds a generation until history, tools, and instructions have loaded", async () => {
    const { tracer, send, events } = setup();
    let resolveHistory: (history: MessageWithParts[]) => void = () => {};
    tracer.configure({
      loadHistory: () =>
        new Promise((resolve) => {
          resolveHistory = resolve;
        }),
    });

    tracer.beginTurn({ sessionID: "ses_1", text: "fast", imageCount: 0 });
    send("message.updated", { info: userMessage() });
    send("message.updated", { info: assistantMessage({}, 1_200) });
    send("session.idle", { sessionID: "ses_1" });
    expect(events("$ai_generation")).toHaveLength(0);
    expect(events("$ai_trace")).toHaveLength(0);

    resolveHistory([
      {
        info: { ...userMessage("msg_old", "ses_1", 10), system: undefined } as never,
        parts: [textPart("prt_old", "msg_old", "Earlier")] as never,
      },
    ]);
    await flush();

    expect(events("$ai_generation")[0].$ai_input[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Earlier" }],
    });
    expect(events("$ai_trace")).toHaveLength(1);
  });

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

  it("finishes a turn after a terminal error even without an idle event", () => {
    vi.useFakeTimers();
    try {
      const { tracer, send, events } = setup();
      tracer.beginTurn({ sessionID: "ses_1", text: "fail", imageCount: 0 });
      send("message.updated", { info: userMessage() });
      send("session.error", {
        sessionID: "ses_1",
        error: { name: "APIError", data: { message: "Invalid API key", isRetryable: false } },
      });
      expect(events("$ai_trace")).toHaveLength(0);

      tracer.beginTurn({ sessionID: "ses_1", text: "retry right away", imageCount: 0 });
      vi.advanceTimersByTime(3_000);

      expect(events("$ai_trace")).toEqual([
        expect.objectContaining({
          $ai_is_error: true,
          $ai_error: "Invalid API key",
          error_name: "APIError",
        }),
      ]);
      send("message.updated", { info: userMessage("msg_next") });
      send("session.idle", { sessionID: "ses_1" });
      expect(events("$ai_trace")[1]).toMatchObject({
        $ai_trace_id: "msg_next",
        $ai_is_error: false,
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("marks aborted turns and drops turns whose prompt failed to send", () => {
    const { tracer, send, events } = setup();

    tracer.beginTurn({ sessionID: "ses_1", text: "never sent", imageCount: 0 });
    tracer.cancelTurn("ses_1");
    tracer.beginTurn({ sessionID: "ses_1", text: "stop halfway", imageCount: 1 });
    send("message.updated", { info: userMessage() });
    send("session.error", {
      sessionID: "ses_1",
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
    });
    send("session.idle", { sessionID: "ses_1" });

    expect(events("$ai_trace")).toEqual([
      expect.objectContaining({
        $ai_input_state: [
          { role: "system", content: "Route Studio calls to studio_id abc." },
          { role: "user", content: "stop halfway" },
        ],
        aborted: true,
        $ai_is_error: false,
        image_count: 1,
      }),
    ]);
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
