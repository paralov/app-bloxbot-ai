/**
 * Unit tests for data-fetching hooks:
 *   useSessions
 *   useProviders (useAllProviders, useConnectedProviders, useAllModels, useAuthMethods)
 *   useMessages (useMessageIds, useMessage)
 *   useSessionStatuses / useIsBusy
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessage, useMessageIds } from "@/hooks/useMessages";
import {
  useAllModels,
  useAllProviders,
  useAuthMethods,
  useConnectedProviders,
} from "@/hooks/useProviders";
import { useIsBusy, useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useSessions } from "@/hooks/useSessions";
import type { Session, SessionStatus } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import { ActiveSessionContext } from "@/providers/ActiveSessionProvider";

// ── Test helpers ─────────────────────────────────────────────────────

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

/** Minimal wrapper providing QueryClient only */
function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** Wrapper providing QueryClient + ActiveSession context */
function makeSessionWrapper(qc: QueryClient, activeSessionId: string | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const ref = useRef<string | null>(activeSessionId);
    return (
      <QueryClientProvider client={qc}>
        <ActiveSessionContext.Provider
          value={{
            activeSessionId,
            selectSession: async () => {},
            clearSession: () => {},
            activeSessionIdRef: ref,
          }}
        >
          {children}
        </ActiveSessionContext.Provider>
      </QueryClientProvider>
    );
  };
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── useSessions ──────────────────────────────────────────────────────

describe("useSessions", () => {
  it("returns sessions from the query cache", () => {
    const qc = makeQC();
    const sessions = [makeSession("s1", "One"), makeSession("s2", "Two")];
    qc.setQueryData(qk.sessions, sessions);

    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper(qc) });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data![0].id).toBe("s1");
  });

  it("returns undefined when cache is empty", () => {
    const qc = makeQC();
    const { result } = renderHook(() => useSessions(), { wrapper: makeWrapper(qc) });
    expect(result.current.data).toBeUndefined();
  });
});

// ── useProviders ─────────────────────────────────────────────────────

describe("useAllProviders", () => {
  it("maps provider data to ProviderInfo array", () => {
    const qc = makeQC();
    qc.setQueryData(qk.providers, {
      all: [
        { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"], models: {} },
        { id: "openai", name: "OpenAI", env: [], models: {} },
      ],
      connected: [],
    });

    const { result } = renderHook(() => useAllProviders(), { wrapper: makeWrapper(qc) });

    expect(result.current).toHaveLength(2);
    expect(result.current[0]).toEqual({
      id: "anthropic",
      name: "Anthropic",
      env: ["ANTHROPIC_API_KEY"],
    });
  });

  it("returns empty array when no data", () => {
    const qc = makeQC();
    const { result } = renderHook(() => useAllProviders(), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual([]);
  });
});

describe("useConnectedProviders", () => {
  it("returns connected provider IDs", () => {
    const qc = makeQC();
    qc.setQueryData(qk.providers, {
      all: [],
      connected: ["anthropic", "openai"],
    });

    const { result } = renderHook(() => useConnectedProviders(), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual(["anthropic", "openai"]);
  });

  it("returns empty array when no data", () => {
    const qc = makeQC();
    const { result } = renderHook(() => useConnectedProviders(), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual([]);
  });
});

describe("useAllModels", () => {
  it("flattens models from all providers", () => {
    const qc = makeQC();
    qc.setQueryData(qk.providers, {
      all: [
        {
          id: "anthropic",
          name: "Anthropic",
          env: [],
          models: {
            "claude-3.5-sonnet": { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
            "claude-3-opus": { id: "claude-3-opus", name: "Claude 3 Opus", status: "beta" },
          },
        },
        {
          id: "openai",
          name: "OpenAI",
          env: [],
          models: {
            "gpt-4": { id: "gpt-4", name: "GPT-4" },
          },
        },
      ],
      connected: [],
    });

    const { result } = renderHook(() => useAllModels(), { wrapper: makeWrapper(qc) });

    expect(result.current).toHaveLength(3);
    expect(result.current[0]).toMatchObject({
      id: "claude-3.5-sonnet",
      name: "Claude 3.5 Sonnet",
      providerId: "anthropic",
      providerName: "Anthropic",
    });
    expect(result.current[1].status).toBe("beta");
    expect(result.current[2].providerId).toBe("openai");
  });
});

describe("useAuthMethods", () => {
  it("returns auth methods when available", () => {
    const qc = makeQC();
    const authMethods = { anthropic: [{ type: "api_key" }] };
    qc.setQueryData(qk.providers, { all: [], connected: [], authMethods });

    const { result } = renderHook(() => useAuthMethods(), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual(authMethods);
  });

  it("returns empty object when no auth methods", () => {
    const qc = makeQC();
    const { result } = renderHook(() => useAuthMethods(), { wrapper: makeWrapper(qc) });
    expect(result.current).toEqual({});
  });
});

// ── useMessages ──────────────────────────────────────────────────────

describe("useMessageIds", () => {
  it("returns message IDs for the active session", () => {
    const qc = makeQC();
    qc.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: ["m1", "m2"],
      messagesById: {
        m1: { info: { id: "m1" } as any, parts: [] },
        m2: { info: { id: "m2" } as any, parts: [] },
      },
    });

    const { result } = renderHook(() => useMessageIds(), {
      wrapper: makeSessionWrapper(qc, "s1"),
    });

    expect(result.current).toEqual(["m1", "m2"]);
  });

  it("returns empty array when no active session", () => {
    const qc = makeQC();
    const { result } = renderHook(() => useMessageIds(), {
      wrapper: makeSessionWrapper(qc, null),
    });
    expect(result.current).toEqual([]);
  });
});

describe("useMessage", () => {
  it("returns a specific message by ID", () => {
    const qc = makeQC();
    qc.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: ["m1"],
      messagesById: {
        m1: {
          info: { id: "m1", role: "assistant" } as any,
          parts: [{ id: "p1", type: "text", text: "hello" } as any],
        },
      },
    });

    const { result } = renderHook(() => useMessage("m1"), {
      wrapper: makeSessionWrapper(qc, "s1"),
    });

    expect(result.current?.info.id).toBe("m1");
    expect(result.current?.parts).toHaveLength(1);
  });

  it("returns undefined for a non-existent message", () => {
    const qc = makeQC();
    qc.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: ["m1"],
      messagesById: { m1: { info: { id: "m1" } as any, parts: [] } },
    });

    const { result } = renderHook(() => useMessage("m999"), {
      wrapper: makeSessionWrapper(qc, "s1"),
    });

    expect(result.current).toBeUndefined();
  });
});

// ── useSessionStatuses / useIsBusy ───────────────────────────────────

describe("useSessionStatuses", () => {
  it("returns statuses from cache", () => {
    const qc = makeQC();
    const statuses = {
      s1: { type: "busy" } as SessionStatus,
      s2: { type: "idle" } as SessionStatus,
    };
    qc.setQueryData(qk.statuses, statuses);

    const { result } = renderHook(() => useSessionStatuses(), { wrapper: makeWrapper(qc) });

    expect(result.current.data).toEqual(statuses);
  });
});

describe("useIsBusy", () => {
  it("returns true when session is busy", () => {
    const qc = makeQC();
    qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });

    const { result } = renderHook(() => useIsBusy("s1"), { wrapper: makeWrapper(qc) });

    expect(result.current).toBe(true);
  });

  it("returns false when session is idle", () => {
    const qc = makeQC();
    qc.setQueryData(qk.statuses, { s1: { type: "idle" } as SessionStatus });

    const { result } = renderHook(() => useIsBusy("s1"), { wrapper: makeWrapper(qc) });

    expect(result.current).toBe(false);
  });

  it("returns false when sessionId is null", () => {
    const qc = makeQC();
    qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });

    const { result } = renderHook(() => useIsBusy(null), { wrapper: makeWrapper(qc) });

    expect(result.current).toBe(false);
  });
});
