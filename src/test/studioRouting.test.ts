import type { McpStatus, OpencodeClient, PermissionRule } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import {
  applyStudioPermissionRouting,
  disconnectSessionStudioServer,
  prepareAutomaticStudioPermissionRouting,
  prepareStudioPromptRouting,
  studioSessionServerName,
} from "@/lib/studioRouting";

function createClient(
  initialStatus: Record<string, McpStatus> = {},
  toolIDs: string[] = [
    "read",
    "roblox-studio_search_game_tree",
    "bloxbot_studio_other_search_game_tree",
  ],
  initialPermissions: PermissionRule[] = [{ permission: "bash", pattern: "*", action: "allow" }],
) {
  const status = { ...initialStatus };
  let permissions = [...initialPermissions];
  const client = {
    session: {
      get: vi.fn().mockImplementation(async () => ({ data: { permission: permissions } })),
      update: vi
        .fn()
        .mockImplementation(async ({ permission }: { permission: PermissionRule[] }) => {
          permissions = permission;
          return { data: { permission } };
        }),
    },
    mcp: {
      status: vi.fn().mockImplementation(async () => ({ data: { ...status } })),
      add: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
        status[name] = { status: "connected" };
        return { data: {} };
      }),
      connect: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
        status[name] = { status: "connected" };
        return { data: true };
      }),
      disconnect: vi.fn().mockImplementation(async ({ name }: { name: string }) => {
        status[name] = { status: "disabled" };
        return { data: true };
      }),
    },
    config: {
      get: vi.fn().mockResolvedValue({
        data: {
          mcp: {
            "roblox-studio": {
              type: "local",
              command: ["StudioMCP"],
              environment: { ROBLOX: "1" },
              enabled: true,
            },
            "bloxbot-studio-router-template": {
              type: "local",
              command: ["electron", "studioMcpRouter.js"],
              environment: {
                BLOXBOT_STUDIO_ROUTER_ENTRY: "1",
                ELECTRON_RUN_AS_NODE: "1",
              },
              enabled: false,
            },
          },
        },
      }),
    },
    tool: {
      ids: vi.fn().mockResolvedValue({ data: toolIDs }),
    },
  };
  return client as unknown as OpencodeClient;
}

describe("Studio session routing", () => {
  it("uses a stable, place-specific MCP server name", () => {
    const first = studioSessionServerName("session/1 with spaces", "studio-a");
    expect(first).toBe(studioSessionServerName("session/1 with spaces", "studio-a"));
    expect(first).not.toBe(studioSessionServerName("session/1 with spaces", "studio-b"));
    expect(first).toMatch(/^bloxbot_studio_/);
  });

  it("creates a router that pins every Studio call to the assigned place", async () => {
    const serverName = studioSessionServerName("session-1", "studio-abc");
    const client = createClient({}, [
      "read",
      "roblox-studio_search_game_tree",
      "bloxbot_studio_other_search_game_tree",
      `${serverName}_search_game_tree`,
    ]);

    const routing = await prepareStudioPromptRouting(client, "session-1", {
      id: "studio-abc",
      name: "Lobby",
    });

    expect(client.mcp.add).toHaveBeenCalledWith(
      {
        name: serverName,
        config: {
          type: "local",
          command: [
            "electron",
            "studioMcpRouter.js",
            "--studio-id",
            "studio-abc",
            "--",
            "StudioMCP",
          ],
          environment: {
            ROBLOX: "1",
            BLOXBOT_STUDIO_ROUTER_ENTRY: "1",
            ELECTRON_RUN_AS_NODE: "1",
          },
          enabled: true,
        },
      },
      { throwOnError: true },
    );
    expect(routing.permissions).toEqual([
      { permission: "roblox-studio_search_game_tree", pattern: "*", action: "deny" },
      { permission: "bloxbot_studio_other_search_game_tree", pattern: "*", action: "deny" },
      { permission: `${serverName}_search_game_tree`, pattern: "*", action: "allow" },
    ]);
    expect(routing.system).toContain("Place selection is enforced automatically");
    expect(routing.system).toContain('"studio-abc"');
  });

  it("restores base Studio tools and disables session routers in automatic mode", async () => {
    const client = createClient();

    await expect(prepareAutomaticStudioPermissionRouting(client)).resolves.toEqual([
      { permission: "roblox-studio_search_game_tree", pattern: "*", action: "allow" },
      { permission: "bloxbot_studio_other_search_game_tree", pattern: "*", action: "deny" },
    ]);
  });

  it("preserves unrelated session permissions while replacing Studio rules", async () => {
    const client = createClient(
      {},
      ["roblox-studio_search_game_tree", "bloxbot_studio_old_search_game_tree"],
      [
        { permission: "bash", pattern: "git status", action: "allow" },
        { permission: "roblox-studio_old", pattern: "*", action: "allow" },
      ],
    );
    const studioPermissions = await prepareAutomaticStudioPermissionRouting(client);

    await applyStudioPermissionRouting(client, "session-1", studioPermissions);

    expect(client.session.update).toHaveBeenCalledWith(
      {
        sessionID: "session-1",
        permission: [
          { permission: "bash", pattern: "git status", action: "allow" },
          { permission: "roblox-studio_search_game_tree", pattern: "*", action: "allow" },
          { permission: "bloxbot_studio_old_search_game_tree", pattern: "*", action: "deny" },
        ],
      },
      { throwOnError: true },
    );
  });

  it("reuses an already connected server for the same session and place", async () => {
    const serverName = studioSessionServerName("session-1", "studio-abc");
    const client = createClient({ [serverName]: { status: "connected" } });

    await prepareStudioPromptRouting(client, "session-1", { id: "studio-abc", name: "Lobby" });

    expect(client.config.get).not.toHaveBeenCalled();
    expect(client.mcp.add).not.toHaveBeenCalled();
    expect(client.mcp.connect).not.toHaveBeenCalled();
  });

  it("rejects an MCP add that reports a failed status", async () => {
    const client = createClient();
    vi.mocked(client.mcp.add).mockImplementationOnce(async ({ name }) => {
      vi.mocked(client.mcp.status).mockResolvedValue({
        data: { [name ?? "missing"]: { status: "failed", error: "Studio not found" } },
      } as never);
      return { data: {} } as never;
    });

    await expect(
      prepareStudioPromptRouting(client, "session-1", { id: "studio-abc", name: "Lobby" }),
    ).rejects.toThrow("Studio not found");
  });

  it("disconnects every router belonging to a deleted session", async () => {
    const first = studioSessionServerName("session-1", "studio-a");
    const second = studioSessionServerName("session-1", "studio-b");
    const other = studioSessionServerName("session-2", "studio-a");
    const client = createClient({
      [first]: { status: "connected" },
      [second]: { status: "failed", error: "closed" },
      [other]: { status: "connected" },
    });

    await disconnectSessionStudioServer(client, "session-1");

    expect(client.mcp.disconnect).toHaveBeenCalledTimes(2);
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ name: first }, { throwOnError: true });
    expect(client.mcp.disconnect).toHaveBeenCalledWith({ name: second }, { throwOnError: true });
  });
});
