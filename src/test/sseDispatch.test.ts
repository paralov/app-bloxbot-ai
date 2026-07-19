/**
 * Unit tests for sseDispatch — the SSE event → React Query cache mapper.
 *
 * These are pure logic tests: no React rendering, just a real QueryClient
 * and assertions on the cache state after dispatching events.
 */

import type {
  Event,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client";
import { QueryClient } from "@tanstack/react-query";
import { Cause, Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";
import { type MessagesCache, sseDispatch, sseDispatchEffect } from "@/lib/sseDispatch";
import type { MessageWithParts } from "@/types";

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
}

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    time: { created: Date.now(), updated: Date.now() },
    version: 1,
    parentID: "",
  } as Session;
}

function dispatch(qc: QueryClient, event: Partial<Event>, activeSessionId: string | null = null) {
  sseDispatch(qc, event as Event, { current: activeSessionId });
}

describe("sseDispatch", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = makeQC();
  });

  // ── Guard clauses ──────────────────────────────────────────────────

  it("ignores null/undefined events", () => {
    dispatch(qc, null as never);
    dispatch(qc, undefined as never);
    // Should not throw
  });

  it("ignores events with no type", () => {
    dispatch(qc, { properties: {} } as never);
  });

  it("rejects an invalid SSE envelope in the typed error channel", () => {
    const result = Effect.runSync(
      Effect.either(
        sseDispatchEffect(qc, { type: "session.created", properties: null }, { current: null }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "SseDispatchError", eventType: "session.created" },
    });
  });

  it("keeps cache programming errors as defects", () => {
    const brokenClient = {
      setQueryData: () => {
        throw new Error("cache programming bug");
      },
    } as unknown as QueryClient;
    const exit = Effect.runSyncExit(
      sseDispatchEffect(
        brokenClient,
        { type: "session.created", properties: { info: makeSession("s1", "One") } },
        { current: null },
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.dieOption(exit.cause)).toMatchObject({
        _tag: "Some",
        value: expect.objectContaining({ message: "cache programming bug" }),
      });
    }
  });

  // ── Session events ─────────────────────────────────────────────────

  describe("session.created", () => {
    it("adds a new session to the sessions cache", () => {
      const existing = makeSession("s1", "One");
      qc.setQueryData(qk.sessions, [existing]);

      dispatch(qc, {
        type: "session.created",
        properties: { info: makeSession("s2", "Two") },
      });

      const sessions = qc.getQueryData<Session[]>(qk.sessions)!;
      expect(sessions).toHaveLength(2);
      expect(sessions[0].id).toBe("s2"); // prepended
    });

    it("does not duplicate an existing session", () => {
      const s1 = makeSession("s1", "One");
      qc.setQueryData(qk.sessions, [s1]);

      dispatch(qc, { type: "session.created", properties: { info: s1 } });

      expect(qc.getQueryData<Session[]>(qk.sessions)).toHaveLength(1);
    });

    it("creates the array when cache is empty", () => {
      dispatch(qc, {
        type: "session.created",
        properties: { info: makeSession("s1", "One") },
      });

      const sessions = qc.getQueryData<Session[]>(qk.sessions)!;
      expect(sessions).toHaveLength(1);
    });
  });

  describe("session.updated", () => {
    it("replaces the matching session in cache", () => {
      qc.setQueryData(qk.sessions, [makeSession("s1", "Old Title")]);

      dispatch(qc, {
        type: "session.updated",
        properties: { info: makeSession("s1", "New Title") },
      });

      const sessions = qc.getQueryData<Session[]>(qk.sessions)!;
      expect(sessions[0].title).toBe("New Title");
    });

    it("leaves non-matching sessions untouched", () => {
      qc.setQueryData(qk.sessions, [makeSession("s1", "One"), makeSession("s2", "Two")]);

      dispatch(qc, {
        type: "session.updated",
        properties: { info: makeSession("s1", "Updated") },
      });

      const sessions = qc.getQueryData<Session[]>(qk.sessions)!;
      expect(sessions[1].title).toBe("Two");
    });
  });

  describe("session.deleted", () => {
    it("removes the session from cache", () => {
      qc.setQueryData(qk.sessions, [makeSession("s1", "One"), makeSession("s2", "Two")]);

      dispatch(qc, {
        type: "session.deleted",
        properties: { info: makeSession("s1", "One") },
      });

      const sessions = qc.getQueryData<Session[]>(qk.sessions)!;
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("s2");
    });
  });

  // ── Session status events ──────────────────────────────────────────

  describe("session.status", () => {
    it("sets session status in the statuses cache", () => {
      qc.setQueryData(qk.statuses, {});

      dispatch(qc, {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      });

      const statuses = qc.getQueryData<Record<string, SessionStatus>>(qk.statuses)!;
      expect(statuses.s1.type).toBe("busy");
    });

    it("skips update when status type is unchanged", () => {
      const initial = { s1: { type: "busy" } as SessionStatus };
      qc.setQueryData(qk.statuses, initial);

      dispatch(qc, {
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      });

      // Should return the same reference (no unnecessary update)
      expect(qc.getQueryData(qk.statuses)).toBe(initial);
    });
  });

  describe("session.idle", () => {
    it("sets session to idle", () => {
      qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });

      dispatch(qc, { type: "session.idle", properties: { sessionID: "s1" } });

      const statuses = qc.getQueryData<Record<string, SessionStatus>>(qk.statuses)!;
      expect(statuses.s1.type).toBe("idle");
    });

    it("skips update when already idle", () => {
      const initial = { s1: { type: "idle" } as SessionStatus };
      qc.setQueryData(qk.statuses, initial);

      dispatch(qc, { type: "session.idle", properties: { sessionID: "s1" } });

      expect(qc.getQueryData(qk.statuses)).toBe(initial);
    });
  });

  // ── Message events ─────────────────────────────────────────────────

  describe("message.updated", () => {
    it("adds a new message to the cache", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), { messageIds: [], messagesById: {} });

      dispatch(
        qc,
        {
          type: "message.updated",
          properties: {
            info: { id: "m1", sessionID: "s1", role: "assistant" },
          },
        },
        "s1",
      );

      const cache = qc.getQueryData<MessagesCache>(qk.messages("s1"))!;
      expect(cache.messageIds).toEqual(["m1"]);
      expect(cache.messagesById.m1.info.id).toBe("m1");
      expect(cache.messagesById.m1.parts).toEqual([]);
    });

    it("updates an existing message's info without losing parts", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: {
          m1: {
            info: { id: "m1", sessionID: "s1", role: "assistant" } as any,
            parts: [{ id: "p1", type: "text", text: "hello" } as any],
          },
        },
      });

      dispatch(
        qc,
        {
          type: "message.updated",
          properties: {
            info: { id: "m1", sessionID: "s1", role: "assistant", metadata: "updated" },
          },
        },
        "s1",
      );

      const cache = qc.getQueryData<MessagesCache>(qk.messages("s1"))!;
      expect(cache.messageIds).toEqual(["m1"]); // not duplicated
      expect(cache.messagesById.m1.parts).toHaveLength(1); // parts preserved
      expect((cache.messagesById.m1.info as any).metadata).toBe("updated");
    });

    it("ignores messages for a different session", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), { messageIds: [], messagesById: {} });

      dispatch(
        qc,
        {
          type: "message.updated",
          properties: { info: { id: "m1", sessionID: "s2" } },
        },
        "s1",
      );

      const cache = qc.getQueryData<MessagesCache>(qk.messages("s1"))!;
      expect(cache.messageIds).toEqual([]);
    });

    it("creates cache from scratch when prev is null", () => {
      dispatch(
        qc,
        {
          type: "message.updated",
          properties: { info: { id: "m1", sessionID: "s1" } },
        },
        "s1",
      );

      const cache = qc.getQueryData<MessagesCache>(qk.messages("s1"))!;
      expect(cache.messageIds).toEqual(["m1"]);
    });
  });

  describe("message.part.updated", () => {
    it("appends a new part to an existing message", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: { m1: { info: { id: "m1" } as any, parts: [] } },
      });

      dispatch(
        qc,
        {
          type: "message.part.updated",
          properties: {
            part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "hi" },
          },
        },
        "s1",
      );

      const msg = qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1;
      expect(msg.parts).toHaveLength(1);
      expect((msg.parts[0] as any).text).toBe("hi");
    });

    it("replaces an existing part by id", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: {
          m1: {
            info: { id: "m1" } as any,
            parts: [{ id: "p1", type: "text", text: "old" } as any],
          },
        },
      });

      dispatch(
        qc,
        {
          type: "message.part.updated",
          properties: {
            part: { id: "p1", messageID: "m1", sessionID: "s1", type: "text", text: "new" },
          },
        },
        "s1",
      );

      const msg = qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1;
      expect(msg.parts).toHaveLength(1);
      expect((msg.parts[0] as any).text).toBe("new");
    });
  });

  describe("message.part.delta", () => {
    it("appends delta text to the correct part", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: {
          m1: {
            info: { id: "m1" } as any,
            parts: [{ id: "p1", type: "text", text: "Hello" } as any],
          },
        },
      });

      dispatch(
        qc,
        {
          type: "message.part.delta",
          properties: { messageID: "m1", partID: "p1", delta: " World" },
        },
        "s1",
      );

      const part = qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1.parts[0];
      expect((part as any).text).toBe("Hello World");
    });

    it("uses field parameter when provided", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: {
          m1: {
            info: { id: "m1" } as any,
            parts: [{ id: "p1", type: "text", text: "base", output: "out" } as any],
          },
        },
      });

      dispatch(
        qc,
        {
          type: "message.part.delta",
          properties: { messageID: "m1", partID: "p1", field: "output", delta: "+more" },
        },
        "s1",
      );

      const part = qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1
        .parts[0] as any;
      expect(part.output).toBe("out+more");
      expect(part.text).toBe("base"); // unchanged
    });

    it("ignores delta when part is not found", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: { m1: { info: { id: "m1" } as any, parts: [] } },
      });

      dispatch(
        qc,
        {
          type: "message.part.delta",
          properties: { messageID: "m1", partID: "nonexistent", delta: "x" },
        },
        "s1",
      );

      // Should not throw, cache unchanged
      expect(qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1.parts).toHaveLength(
        0,
      );
    });
  });

  describe("message.removed", () => {
    it("removes a message from the cache", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1", "m2"],
        messagesById: {
          m1: { info: { id: "m1" } as any, parts: [] },
          m2: { info: { id: "m2" } as any, parts: [] },
        },
      });

      dispatch(
        qc,
        { type: "message.removed", properties: { sessionID: "s1", messageID: "m1" } },
        "s1",
      );

      const cache = qc.getQueryData<MessagesCache>(qk.messages("s1"))!;
      expect(cache.messageIds).toEqual(["m2"]);
      expect(cache.messagesById.m1).toBeUndefined();
    });
  });

  describe("message.part.removed", () => {
    it("removes a part from a message", () => {
      qc.setQueryData<MessagesCache>(qk.messages("s1"), {
        messageIds: ["m1"],
        messagesById: {
          m1: {
            info: { id: "m1" } as any,
            parts: [{ id: "p1", type: "text" } as any, { id: "p2", type: "text" } as any],
          },
        },
      });

      dispatch(
        qc,
        {
          type: "message.part.removed",
          properties: { sessionID: "s1", messageID: "m1", partID: "p1" },
        },
        "s1",
      );

      const parts = qc.getQueryData<MessagesCache>(qk.messages("s1"))!.messagesById.m1.parts;
      expect(parts).toHaveLength(1);
      expect(parts[0].id).toBe("p2");
    });
  });

  // ── Todo events ────────────────────────────────────────────────────

  describe("todo.updated", () => {
    it("replaces the todos cache for the active session", () => {
      qc.setQueryData(qk.todos("s1"), []);
      const newTodos = [{ id: "t1", content: "Do something" }] as unknown as Todo[];

      dispatch(
        qc,
        { type: "todo.updated", properties: { sessionID: "s1", todos: newTodos } },
        "s1",
      );

      expect(qc.getQueryData<Todo[]>(qk.todos("s1"))).toEqual(newTodos);
    });

    it("ignores todos for a different session", () => {
      qc.setQueryData(qk.todos("s1"), []);

      dispatch(
        qc,
        { type: "todo.updated", properties: { sessionID: "s2", todos: [{ id: "t1" }] } },
        "s1",
      );

      expect(qc.getQueryData<Todo[]>(qk.todos("s1"))).toEqual([]);
    });
  });

  // ── Question events ────────────────────────────────────────────────

  describe("question.asked", () => {
    it("sets the active question", () => {
      dispatch(
        qc,
        {
          type: "question.asked",
          properties: { id: "q1", sessionID: "s1", questions: [] },
        },
        "s1",
      );

      const q = qc.getQueryData<QuestionRequest | null>(qk.questions);
      expect((q as any).id).toBe("q1");
    });
  });

  describe("question.replied / question.rejected", () => {
    it("clears the question on reply", () => {
      qc.setQueryData(qk.questions, { id: "q1", sessionID: "s1" });

      dispatch(qc, { type: "question.replied", properties: { sessionID: "s1" } }, "s1");

      expect(qc.getQueryData(qk.questions)).toBeNull();
    });

    it("clears the question on reject", () => {
      qc.setQueryData(qk.questions, { id: "q1", sessionID: "s1" });

      dispatch(qc, { type: "question.rejected", properties: { sessionID: "s1" } }, "s1");

      expect(qc.getQueryData(qk.questions)).toBeNull();
    });
  });

  // ── Permission events ──────────────────────────────────────────────

  describe("permission.asked", () => {
    it("sets the active permission request", () => {
      dispatch(
        qc,
        {
          type: "permission.asked",
          properties: { id: "p1", sessionID: "s1", permission: "bash", patterns: [] },
        },
        "s1",
      );

      const p = qc.getQueryData<PermissionRequest | null>(qk.permissions);
      expect((p as any).id).toBe("p1");
    });
  });

  describe("permission.replied", () => {
    it("clears the permission request", () => {
      qc.setQueryData(qk.permissions, { id: "p1", sessionID: "s1" });

      dispatch(qc, { type: "permission.replied", properties: { sessionID: "s1" } }, "s1");

      expect(qc.getQueryData(qk.permissions)).toBeNull();
    });
  });

  // ── MCP events ─────────────────────────────────────────────────────

  describe("mcp.tools.changed", () => {
    it("is a no-op (studio status indicator removed)", () => {
      const spy = vi.spyOn(qc, "invalidateQueries");

      dispatch(qc, { type: "mcp.tools.changed", properties: {} });

      expect(spy).not.toHaveBeenCalled();
    });
  });
});
