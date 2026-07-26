import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it, vi } from "vitest";

import {
  disconnectSessionStudioServer,
  prepareStudioPromptRouting,
  studioSessionServerName,
} from "@/lib/studioRouting";

function createClient(status: Record<string, { status: string }> = {}) {
  return {
    mcp: {
      status: vi.fn().mockResolvedValue({ data: status }),
      add: vi.fn().mockResolvedValue({ data: {} }),
      connect: vi.fn().mockResolvedValue({ data: true }),
      disconnect: vi.fn().mockResolvedValue({ data: true }),
    },
    config: {
      get: vi.fn().mockResolvedValue({
        data: {
          mcp: {
            "roblox-studio": {
              type: "local",
              command: ["StudioMCP"],
              enabled: true,
            },
          },
        },
      }),
    },
    tool: {
      ids: vi.fn().mockResolvedValue({
        data: [
          "read",
          "roblox-studio_search_game_tree",
          "bloxbot_studio_other_search_game_tree",
          "bloxbot_studio_session-1_set_active_studio",
          "bloxbot_studio_session-1_search_game_tree",
        ],
      }),
    },
  } as unknown as OpencodeClient;
}

describe("Studio session routing", () => {
  it("uses a stable MCP server name for each session", () => {
    expect(studioSessionServerName("session/1 with spaces")).toBe(
      "bloxbot_studio_session_1_with_spaces",
    );
  });

  it("creates an isolated MCP server and disables other Studio tools", async () => {
    const client = createClient();

    const routing = await prepareStudioPromptRouting(client, "session-1", {
      id: "studio-abc",
      name: "Lobby",
    });

    expect(client.mcp.add).toHaveBeenCalledWith(
      {
        name: "bloxbot_studio_session-1",
        config: { type: "local", command: ["StudioMCP"], enabled: true },
      },
      { throwOnError: true },
    );
    expect(routing.tools).toEqual({
      "roblox-studio_search_game_tree": false,
      bloxbot_studio_other_search_game_tree: false,
      "bloxbot_studio_session-1_set_active_studio": true,
      "bloxbot_studio_session-1_search_game_tree": true,
    });
    expect(routing.system).toContain("bloxbot_studio_session-1_set_active_studio");
    expect(routing.system).toContain('"studio-abc"');
  });

  it("reuses an already connected session server", async () => {
    const serverName = studioSessionServerName("session-1");
    const client = createClient({ [serverName]: { status: "connected" } });

    await prepareStudioPromptRouting(client, "session-1", { id: "studio-abc", name: "Lobby" });

    expect(client.config.get).not.toHaveBeenCalled();
    expect(client.mcp.add).not.toHaveBeenCalled();
    expect(client.mcp.connect).not.toHaveBeenCalled();
  });

  it("disconnects the session-specific server when a session is deleted", async () => {
    const serverName = studioSessionServerName("session-1");
    const client = createClient({ [serverName]: { status: "connected" } });

    await disconnectSessionStudioServer(client, "session-1");

    expect(client.mcp.disconnect).toHaveBeenCalledWith(
      { name: serverName },
      { throwOnError: true },
    );
  });
});
