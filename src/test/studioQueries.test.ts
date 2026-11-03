import { describe, expect, it, vi } from "vitest";

import {
  type CallStudioTool,
  discoverStudioTargets,
  inspectExplorerNode,
  readExplorerSnapshot,
  selectStudioTarget,
} from "../../electron/studioQueries";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const failure = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

const rows = [
  { className: "DataModel", name: "Obby" },
  { fullPath: "Workspace", className: "Workspace", name: "Workspace" },
  { fullPath: "Workspace.Baseplate", className: "Part", properties: { Name: "Base" } },
  { fullPath: "Workspace.Model", className: "Model", name: "Model", unexploredChildCount: 3 },
  { fullPath: "CoreGui", className: "CoreGui", name: "CoreGui" },
];

describe("readExplorerSnapshot", () => {
  it("builds the tree, keeps Studio's default services and reads the place name", async () => {
    const callTool = vi.fn<CallStudioTool>(async () => json({ instances: rows }));

    const snapshot = await readExplorerSnapshot(callTool, "studio-1");

    expect(callTool).toHaveBeenCalledWith("search_game_tree", {
      studio_id: "studio-1",
      datamodel_type: "Edit",
      max_depth: 10,
      head_limit: 100000,
    });
    expect(snapshot.placeName).toBe("Obby");
    expect(snapshot.roots.map((root) => root.path)).toEqual(["game.Workspace"]);
    const [workspace] = snapshot.roots;
    expect(workspace?.hasChildren).toBe(true);
    expect(workspace?.children.map((child) => child.name)).toEqual(["Base", "Model"]);
    expect(workspace?.children[1]?.hasChildren).toBe(true);
  });

  it("reads JSON that follows Studio's note about limits", async () => {
    const callTool: CallStudioTool = async () => ({
      content: [{ type: "text", text: `Note: Output limited to 1 nodes\n${JSON.stringify(rows)}` }],
    });

    const snapshot = await readExplorerSnapshot(callTool, "studio-1");

    expect(snapshot.roots).toHaveLength(1);
  });

  it("falls back through the data models during a playtest", async () => {
    const callTool = vi
      .fn<CallStudioTool>()
      .mockResolvedValueOnce(failure("Edit is not available in Play mode"))
      .mockResolvedValueOnce(failure("Studio can't reach the server"))
      .mockResolvedValueOnce(json(rows));

    const snapshot = await readExplorerSnapshot(callTool, "studio-1");

    expect(callTool.mock.calls.map(([, args]) => args.datamodel_type)).toEqual([
      "Edit",
      "Server",
      "Client",
    ]);
    expect(snapshot.roots).toHaveLength(1);
  });

  it("reports Studio's reasons when no data model answers, leaving out repeats", async () => {
    const callTool = vi
      .fn<CallStudioTool>()
      .mockResolvedValueOnce(failure("Studio is busy"))
      .mockResolvedValueOnce(failure("Server is not available in Edit mode"))
      .mockResolvedValueOnce(failure("Client crashed"));

    await expect(readExplorerSnapshot(callTool, "studio-1")).rejects.toThrow(
      "Studio is busy (client data model: Client crashed)",
    );
  });
});

describe("Studio targets", () => {
  const studios = {
    studios: [
      { studio_id: "a", name: "Obby", place_id: 123 },
      { studioId: "b" },
      { name: "No id" },
    ],
  };

  it("lists the Studios that have an id", async () => {
    await expect(discoverStudioTargets(async () => json(studios))).resolves.toEqual({
      selectedKey: null,
      targets: [
        { key: "a", label: "Obby", detail: "Place 123", placeId: "123" },
        { key: "b", label: "b", detail: "Local place", placeId: null },
      ],
    });
  });

  it("verifies a selection against the Studios open now", async () => {
    const callTool: CallStudioTool = async () => json(studios);

    await expect(selectStudioTarget(callTool, "a")).resolves.toMatchObject({
      verified: true,
      selected: { key: "a", label: "Obby" },
    });
    await expect(selectStudioTarget(callTool, "gone")).rejects.toThrow("could not be verified");
  });

  // Shapes recorded from Roblox Studio.
  it("reads an object's properties when it's selected", async () => {
    const callTool = vi.fn<CallStudioTool>(async () =>
      json({
        path: "Workspace.Baseplate",
        className: "Part",
        children: { childrenCount: 1 },
        properties: { Anchored: true, Size: "2048, 16, 2048", Transparency: 0 },
      }),
    );
    await expect(
      inspectExplorerNode(callTool, "studio-1", "game.Workspace.Baseplate"),
    ).resolves.toEqual({
      properties: [
        { name: "Anchored", value: "true" },
        { name: "Size", value: "2048, 16, 2048" },
        { name: "Transparency", value: "0" },
      ],
      attributes: [],
    });
    expect(callTool).toHaveBeenCalledWith("inspect_instance", {
      studio_id: "studio-1",
      path: "game.Workspace.Baseplate",
    });
  });

  it("reads properties another way when Studio's inspect tool has none, as for Terrain", async () => {
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === "inspect_instance") return json({ name: "Terrain", properties: [] });
      if (args.datamodel_type === "Edit") return failure("Edit is not available in Play mode");
      return json({ WaterColor: "0.04, 0.32, 0.36" });
    });
    await expect(
      inspectExplorerNode(callTool, "studio-1", 'game.Workspace.Ter"rain'),
    ).resolves.toEqual({
      properties: [{ name: "WaterColor", value: "0.04, 0.32, 0.36" }],
      attributes: [],
    });
    const [, args] = callTool.mock.lastCall ?? [];
    expect(args?.datamodel_type).toBe("Server");
    expect(args?.code).toContain('"Workspace.Ter\\"rain"');
  });

  it("shows the first of several objects that share a path", async () => {
    const callTool = async () =>
      json({ matches: [{ properties: { Anchored: true } }, { properties: { Anchored: false } }] });
    await expect(inspectExplorerNode(callTool, "studio-1", "game.Workspace.Part")).resolves.toEqual(
      {
        properties: [{ name: "Anchored", value: "true" }],
        attributes: [],
      },
    );
  });

  it("reports Studio's errors and unusable output instead of showing nothing", async () => {
    await expect(discoverStudioTargets(async () => failure("Studio is busy"))).rejects.toThrow(
      "Studio is busy",
    );
    const text = async () => ({
      content: [{ type: "text" as const, text: "No Studio connected" }],
    });
    await expect(readExplorerSnapshot(text, "studio-1")).rejects.toThrow("unreadable");
  });
});
