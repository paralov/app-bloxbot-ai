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

    await expect(checkStudioConnection(client as never)).resolves.toBe("connected");
    expect(client.mcp.connect).not.toHaveBeenCalled();
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

    await expect(checkStudioConnection(client as never)).resolves.toBe("connected");
    expect(client.mcp.connect).toHaveBeenCalledWith({ name: "roblox-studio" });
  });

  it("keeps waiting when the MCP still reports a failed connection", async () => {
    const client = {
      mcp: {
        status: vi.fn().mockResolvedValue({ data: { "roblox-studio": { status: "failed" } } }),
        connect: vi.fn().mockResolvedValue({}),
      },
    };

    await expect(checkStudioConnection(client as never)).resolves.toBe("waiting");
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
});
