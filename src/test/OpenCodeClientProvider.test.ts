import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/queryKeys";
import { prefetchServerState, reconcileServerState } from "@/providers/OpenCodeClientProvider";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

describe("OpenCode query lifecycle", () => {
  it("keeps successful startup snapshots when another endpoint fails", async () => {
    const client = {
      experimental: {
        session: { list: vi.fn().mockRejectedValue(new Error("sessions unavailable")) },
      },
      session: {
        status: vi.fn().mockResolvedValue({ data: { s1: { type: "idle" } } }),
      },
      provider: {
        list: vi.fn().mockResolvedValue({
          data: { all: [], connected: [], default: {} },
        }),
        auth: vi.fn().mockRejectedValue(new Error("auth unavailable")),
      },
      app: {
        agents: vi.fn().mockResolvedValue({ data: [{ name: "build", mode: "primary" }] }),
      },
    } as unknown as OpencodeClient;
    const queryClient = makeQueryClient();

    await expect(prefetchServerState(client, queryClient)).resolves.toBeUndefined();

    expect(queryClient.getQueryData(qk.sessions)).toBeUndefined();
    expect(queryClient.getQueryData(qk.statuses)).toEqual({ s1: { type: "idle" } });
    expect(queryClient.getQueryData(qk.providers)).toEqual({
      all: [],
      connected: [],
      default: {},
    });
    expect(queryClient.getQueryData(qk.agents)).toEqual([{ name: "build", mode: "primary" }]);
  });

  it("fails startup when every server-state endpoint is unavailable", async () => {
    const unavailable = vi.fn().mockRejectedValue(new Error("unavailable"));
    const client = {
      experimental: { session: { list: unavailable } },
      session: { status: unavailable },
      provider: { list: unavailable, auth: unavailable },
      app: { agents: unavailable },
    } as unknown as OpencodeClient;

    await expect(prefetchServerState(client, makeQueryClient())).rejects.toThrow(
      "OpenCode server state is unavailable",
    );
  });

  it("invalidates every active-session snapshot after SSE connects", async () => {
    const queryClient = makeQueryClient();
    const activeKeys = [
      qk.sessions,
      qk.statuses,
      qk.providers,
      qk.agents,
      qk.messages("s1"),
      qk.todos("s1"),
      qk.questions("s1"),
      qk.permissions("s1"),
    ];
    for (const queryKey of activeKeys) queryClient.setQueryData(queryKey, {});
    queryClient.setQueryData(qk.messages("s2"), {});

    await reconcileServerState(queryClient, "s1");

    for (const queryKey of activeKeys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(qk.messages("s2"))?.isInvalidated).toBe(false);
  });
});
