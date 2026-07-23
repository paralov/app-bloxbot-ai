import { describe, expect, it, vi } from "vitest";

import { checkStudioConnection } from "@/hooks/useStudioConnection";

describe("checkStudioConnection", () => {
  it("reports an existing Studio connection without reconnecting", async () => {
    const client = {
      mcp: {
        status: vi.fn().mockResolvedValue({
          data: { "roblox-studio": { status: "connected" } },
        }),
        connect: vi.fn(),
      },
    };
    const detectStudioConnection = vi.fn().mockResolvedValue(true);

    await expect(checkStudioConnection(client as never, detectStudioConnection)).resolves.toBe(
      "connected",
    );
    expect(client.mcp.connect).not.toHaveBeenCalled();
    expect(detectStudioConnection).toHaveBeenCalledOnce();
  });

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

    await expect(checkStudioConnection(client as never, async () => true)).resolves.toBe(
      "connected",
    );
    expect(client.mcp.connect).toHaveBeenCalledWith({ name: "roblox-studio" });
  });

  it("keeps waiting when Roblox Studio is not connected to the MCP bridge", async () => {
    const client = {
      mcp: {
        status: vi.fn().mockResolvedValue({
          data: { "roblox-studio": { status: "connected" } },
        }),
        connect: vi.fn(),
      },
    };

    await expect(checkStudioConnection(client as never, async () => false)).resolves.toBe(
      "waiting",
    );
  });

  it("keeps waiting when Studio is unavailable", async () => {
    const client = {
      mcp: {
        status: vi.fn().mockRejectedValue(new Error("Studio is closed")),
        connect: vi.fn(),
      },
    };

    await expect(checkStudioConnection(client as never, async () => true)).resolves.toBe("waiting");
  });
});
