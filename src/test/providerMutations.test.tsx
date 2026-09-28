import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useSetApiKey } from "@/hooks/mutations/useSetApiKey";
import { qk } from "@/lib/queryKeys";

const client = {
  auth: { set: vi.fn() },
  instance: { dispose: vi.fn() },
  provider: { list: vi.fn(), auth: vi.fn() },
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
