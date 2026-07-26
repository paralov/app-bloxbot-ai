import { describe, expect, it, vi } from "vitest";

import { StudioMcpRouter } from "../../electron/studioMcpRouter";

function setup() {
  const studio: object[] = [];
  const client: object[] = [];
  const fail = vi.fn();
  return {
    studio,
    client,
    fail,
    router: new StudioMcpRouter(
      "studio-a",
      (message) => studio.push(message),
      (message) => client.push(message),
      fail,
    ),
  };
}

describe("StudioMcpRouter", () => {
  it("selects once before exposing Studio tools", () => {
    const { router, studio, client } = setup();
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list" };

    router.handleClient({ jsonrpc: "2.0", method: "notifications/initialized" });
    router.handleClient(list);
    const selection = studio[1] as { id: string };
    expect(studio).toEqual([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        jsonrpc: "2.0",
        id: selection.id,
        method: "tools/call",
        params: { name: "set_active_studio", arguments: { studio_id: "studio-a" } },
      },
    ]);
    expect(selection.id).toMatch(/^__bloxbot_select_studio_/);

    router.handleStudio({ id: selection.id, result: { content: [] } });
    expect(studio.at(-1)).toEqual(list);
    router.handleStudio({
      id: 2,
      result: {
        tools: [
          { name: "set_active_studio" },
          { name: "list_roblox_studios" },
          { name: "search_game_tree" },
        ],
      },
    });
    expect(client).toEqual([{ id: 2, result: { tools: [{ name: "search_game_tree" }] } }]);
  });

  it("fails the server when the assigned Studio cannot be selected", () => {
    const { router, studio, fail } = setup();
    router.handleClient({ method: "notifications/initialized" });
    router.handleStudio({ id: (studio[1] as { id: string }).id, result: { isError: true } });
    expect(fail).toHaveBeenCalledWith("StudioMCP could not select the assigned place");
  });

  it("passes unrelated protocol traffic through", () => {
    const { router, studio, client } = setup();
    router.handleClient({ id: 1, method: "initialize" });
    router.handleStudio({ id: 1, result: { protocolVersion: "2024-11-05" } });
    expect(studio).toEqual([{ id: 1, method: "initialize" }]);
    expect(client).toEqual([{ id: 1, result: { protocolVersion: "2024-11-05" } }]);
  });
});
