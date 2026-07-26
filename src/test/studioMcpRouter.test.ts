import { describe, expect, it } from "vitest";

import { StudioMcpRouter } from "../../electron/studioMcpRouter";

describe("StudioMcpRouter", () => {
  it("hides Studio selection controls from the model", () => {
    const studioMessages: object[] = [];
    const clientMessages: object[] = [];
    const router = new StudioMcpRouter(
      "studio-a",
      (message) => studioMessages.push(message),
      (message) => clientMessages.push(message),
    );

    router.handleClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    router.handleStudioMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "set_active_studio" },
          { name: "list_roblox_studios" },
          { name: "search_game_tree" },
        ],
      },
    });

    expect(studioMessages).toHaveLength(1);
    expect(clientMessages).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "search_game_tree" }] },
      },
    ]);
  });

  it("selects the assigned Studio before forwarding every tool call", () => {
    const studioMessages: object[] = [];
    const clientMessages: object[] = [];
    const router = new StudioMcpRouter(
      "studio-a",
      (message) => studioMessages.push(message),
      (message) => clientMessages.push(message),
    );
    const toolCall = {
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "search_game_tree", arguments: { query: "Spawn" } },
    };

    router.handleClientMessage(toolCall);
    expect(studioMessages[0]).toMatchObject({
      method: "tools/call",
      params: { name: "set_active_studio", arguments: { studio_id: "studio-a" } },
    });
    const selectionID = (studioMessages[0] as { id: string }).id;
    router.handleStudioMessage({ jsonrpc: "2.0", id: selectionID, result: { content: [] } });

    expect(studioMessages[1]).toEqual(toolCall);
    expect(clientMessages).toEqual([]);
  });

  it("does not run the requested tool when Studio selection fails", () => {
    const studioMessages: object[] = [];
    const clientMessages: object[] = [];
    const router = new StudioMcpRouter(
      "studio-a",
      (message) => studioMessages.push(message),
      (message) => clientMessages.push(message),
    );

    router.handleClientMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_game_tree", arguments: {} },
    });
    const selectionID = (studioMessages[0] as { id: string }).id;
    router.handleStudioMessage({
      jsonrpc: "2.0",
      id: selectionID,
      result: { isError: true, content: [{ type: "text", text: "Studio disconnected" }] },
    });

    expect(studioMessages).toHaveLength(1);
    expect(clientMessages).toEqual([
      {
        jsonrpc: "2.0",
        id: 7,
        result: { isError: true, content: [{ type: "text", text: "Studio disconnected" }] },
      },
    ]);
  });

  it("cancels the hidden selection request without running the original tool", () => {
    const studioMessages: object[] = [];
    const clientMessages: object[] = [];
    const router = new StudioMcpRouter(
      "studio-a",
      (message) => studioMessages.push(message),
      (message) => clientMessages.push(message),
    );

    router.handleClientMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search_game_tree", arguments: {} },
    });
    const selectionID = (studioMessages[0] as { id: string }).id;
    router.handleClientMessage({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "aborted" },
    });
    router.handleStudioMessage({ jsonrpc: "2.0", id: selectionID, result: { content: [] } });

    expect(studioMessages).toEqual([
      expect.objectContaining({ id: selectionID, method: "tools/call" }),
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: selectionID, reason: "aborted" },
      },
    ]);
    expect(clientMessages).toEqual([]);
  });

  it("cannot be redirected to a different Studio by an explicit selection call", () => {
    const studioMessages: object[] = [];
    const router = new StudioMcpRouter(
      "studio-a",
      (message) => studioMessages.push(message),
      () => undefined,
    );

    router.handleClientMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "set_active_studio", arguments: { studio_id: "studio-b" } },
    });

    expect(studioMessages).toEqual([
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "set_active_studio", arguments: { studio_id: "studio-a" } },
      },
    ]);
  });
});
