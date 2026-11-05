import { describe, expect, it, vi } from "vitest";

import { checkStudioConnection } from "@/hooks/useStudioConnection";

describe("checkStudioConnection", () => {
  it("retries the Studio connection and detects when setup is complete", async () => {
    const client = {
      mcp: {
        status: vi
          .fn()
          .mockResolvedValueOnce({ data: { "roblox-studio": { status: "failed" } } })
          .mockResolvedValueOnce({ data: { "roblox-studio": { status: "connected" } } }),
        connect: vi.fn().mockResolvedValue({}),
      },
    };

    await expect(checkStudioConnection(client as never)).resolves.toBe("connected");
    expect(client.mcp.connect).toHaveBeenCalledWith({ name: "roblox-studio" });
  });

  it("keeps waiting when Studio is unavailable", async () => {
    const client = {
      mcp: {
        status: vi.fn().mockRejectedValue(new Error("Studio is closed")),
        connect: vi.fn(),
      },
    };

    await expect(checkStudioConnection(client as never)).resolves.toBe("waiting");
  });

  it("waits on a hung check rather than starting another", async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: unknown) => void = () => {};
      const client = {
        mcp: {
          status: vi
            .fn()
            .mockReturnValueOnce(
              new Promise((resolve) => {
                answer = resolve;
              }),
            )
            .mockResolvedValue({ data: { "roblox-studio": { status: "connected" } } }),
          connect: vi.fn(),
        },
      };

      const first = checkStudioConnection(client as never);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toBe("waiting");
      const second = checkStudioConnection(client as never);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(second).resolves.toBe("waiting");
      expect(client.mcp.status).toHaveBeenCalledTimes(1);

      answer({ data: { "roblox-studio": { status: "connected" } } });
      await vi.advanceTimersByTimeAsync(0);
      await expect(checkStudioConnection(client as never)).resolves.toBe("connected");
      expect(client.mcp.status).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
