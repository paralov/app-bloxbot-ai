import { describe, expect, it } from "vitest";

import { parseStudioListResult } from "../../electron/services/RobloxStudio";

describe("Roblox Studio MCP discovery", () => {
  it("parses connected Studio instances from the MCP tool result", () => {
    expect(
      parseStudioListResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              studios: [
                { id: "studio-1", name: "Lobby", active: true },
                { id: "studio-2", name: "Dungeon", active: false },
              ],
            }),
          },
        ],
      }),
    ).toEqual([
      { id: "studio-1", name: "Lobby", active: true },
      { id: "studio-2", name: "Dungeon", active: false },
    ]);
  });

  it("rejects malformed MCP results", () => {
    expect(() => parseStudioListResult({ content: [] })).toThrow(
      "StudioMCP did not return a place list",
    );
  });

  it("normalizes malformed JSON into the place-list validation error", () => {
    expect(() => parseStudioListResult({ content: [{ type: "text", text: "not json" }] })).toThrow(
      "StudioMCP returned an invalid place list",
    );
  });
});
