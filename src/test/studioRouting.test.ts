import type { McpStatus, OpencodeClient, PermissionRule } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import {
  disconnectSessionStudioServer,
  routeAssignedStudio,
  routeAutomaticStudio,
  studioSessionServerName,
} from "@/lib/studioRouting";

function clientWith(
  toolIDs = ["roblox-studio_search", "bloxbot_studio_old_search"],
  initialStatus: Record<string, McpStatus> = {},
) {
  const status = { ...initialStatus };
  let permission: PermissionRule[] = [{ permission: "bash", pattern: "*", action: "allow" }];
  return {
    session: {
      get: vi.fn(async () => ({ data: { permission } })),
      update: vi.fn(async (input: { permission: PermissionRule[] }) => {
        permission = input.permission;
        return { data: {} };
      }),
    },
    tool: { ids: vi.fn(async () => ({ data: toolIDs })) },
    config: {
      get: vi.fn(async () => ({
        data: {
          mcp: {
            "roblox-studio": { type: "local", command: ["StudioMCP"], enabled: true },
            "bloxbot-studio-router-template": {
              type: "local",
              command: ["electron", "studioMcpRouter.js"],
              environment: { ELECTRON_RUN_AS_NODE: "1" },
              enabled: false,
            },
          },
        },
      })),
    },
    mcp: {
      status: vi.fn(async () => ({ data: { ...status } })),
      add: vi.fn(async ({ name }: { name: string }) => {
        status[name] = { status: "connected" };
        return { data: {} };
      }),
      connect: vi.fn(async ({ name }: { name: string }) => {
        status[name] = { status: "connected" };
        return { data: true };
      }),
      disconnect: vi.fn(async ({ name }: { name: string }) => {
        status[name] = { status: "disabled" };
        return { data: true };
      }),
    },
  } as unknown as OpencodeClient;
}

describe("Studio routing", () => {
  it("adds one place-specific server and preserves non-Studio permissions", async () => {
    const server = studioSessionServerName("s1", "studio-a");
    const oldServer = studioSessionServerName("s1", "studio-old");
    const client = clientWith(["roblox-studio_search", `${server}_search`], {
      [oldServer]: { status: "connected" },
    });

    const system = await routeAssignedStudio(client, "s1", { id: "studio-a", name: "Lobby" });

    expect(client.mcp.add).toHaveBeenCalledWith(
      {
        name: server,
        config: {
          type: "local",
          command: ["electron", "studioMcpRouter.js", "--studio-id", "studio-a", "--", "StudioMCP"],
          environment: { ELECTRON_RUN_AS_NODE: "1" },
          enabled: true,
        },
      },
      { throwOnError: true },
    );
    expect(client.mcp.disconnect).toHaveBeenCalledWith(
      { name: oldServer },
      { throwOnError: true },
    );
    expect(client.session.update).toHaveBeenCalledWith(
      {
        sessionID: "s1",
        permission: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "roblox-studio_search", pattern: "*", action: "deny" },
          { permission: `${server}_search`, pattern: "*", action: "allow" },
        ],
      },
      { throwOnError: true },
    );
    expect(system).toContain(`${server}_`);
  });

  it("restores the base server for automatic selection", async () => {
    const client = clientWith();
    await routeAutomaticStudio(client, "s1");
    expect(client.session.update).toHaveBeenCalledWith(
      {
        sessionID: "s1",
        permission: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "roblox-studio_search", pattern: "*", action: "allow" },
          { permission: "bloxbot_studio_old_search", pattern: "*", action: "deny" },
        ],
      },
      { throwOnError: true },
    );
  });

  it("disconnects only servers belonging to the session", async () => {
    const mine = studioSessionServerName("s1", "studio-a");
    const other = studioSessionServerName("s2", "studio-a");
    const client = clientWith([], {
      [mine]: { status: "connected" },
      [other]: { status: "connected" },
    });
    await disconnectSessionStudioServer(client, "s1");
    expect(client.mcp.disconnect).toHaveBeenCalledTimes(1);
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ name: mine }, { throwOnError: true });
  });
});
