import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useCheckProvider } from "@/hooks/mutations/useCheckProvider";
import { useSetApiKey } from "@/hooks/mutations/useSetApiKey";
import { qk } from "@/lib/queryKeys";

const client = {
  auth: { set: vi.fn() },
  instance: { dispose: vi.fn() },
  provider: { list: vi.fn(), auth: vi.fn() },
  session: { create: vi.fn(), prompt: vi.fn(), delete: vi.fn() },
  permission: { list: vi.fn(), reply: vi.fn() },
};

vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client }),
}));

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useSetApiKey", () => {
  it("reports a saved key as saved when the refresh afterwards fails", async () => {
    client.auth.set.mockResolvedValue({ data: true });
    client.instance.dispose.mockRejectedValue(new Error("instance busy"));
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();

    const { result } = renderHook(() => useSetApiKey(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "opencode-go", key: "sk-test" }),
    ).resolves.toBeUndefined();
    expect(client.auth.set).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: qk.providers });
  });

  it("still fails when the key itself can't be saved", async () => {
    client.auth.set.mockRejectedValue({ name: "BadRequest", data: { message: "bad" } });
    const qc = new QueryClient();

    const { result } = renderHook(() => useSetApiKey(), { wrapper: wrapper(qc) });

    await expect(
      result.current.mutateAsync({ providerID: "opencode-go", key: "sk-test" }),
    ).rejects.toMatchObject({ name: "BadRequest" });
  });
});

describe("useCheckProvider", () => {
  it("runs the check where no tool can act, rejecting its own approval requests", async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.providers, {
      all: [
        {
          id: "opencode-go",
          models: {
            "kimi-k3": {
              id: "kimi-k3",
              name: "Kimi K3",
              status: "active",
              cost: { input: 3, output: 15 },
            },
          },
        },
      ],
      connected: ["opencode-go"],
    });
    client.session.create.mockResolvedValue({ data: { id: "check-session" } });
    client.session.delete.mockResolvedValue({ data: true });
    client.permission.list.mockResolvedValue({
      data: [
        { id: "mine", sessionID: "check-session", permission: "bash" },
        { id: "theirs", sessionID: "user-chat", permission: "edit" },
      ],
    });
    // The model asks to run a tool; the prompt only finishes once that is rejected.
    let rejected: () => void = () => {};
    const rejection = new Promise<void>((resolve) => {
      rejected = resolve;
    });
    client.permission.reply.mockImplementation(async () => {
      rejected();
      return { data: true };
    });
    client.session.prompt.mockImplementation(async () => {
      await rejection;
      return { data: { info: {}, parts: [] } };
    });

    const { result } = renderHook(() => useCheckProvider(), { wrapper: wrapper(qc) });

    await expect(result.current.mutateAsync("opencode-go")).resolves.toEqual({
      ok: true,
      modelName: "Kimi K3",
    });
    expect(client.session.create.mock.calls[0][0].permission).toEqual([
      { permission: "*", pattern: "*", action: "ask" },
    ]);
    expect(client.permission.reply).toHaveBeenCalledWith({ requestID: "mine", reply: "reject" });
    expect(client.permission.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestID: "theirs" }),
    );
    expect(client.session.delete).toHaveBeenCalledWith(
      { sessionID: "check-session" },
      { throwOnError: true },
    );
  });
});
