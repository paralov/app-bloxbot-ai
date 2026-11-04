import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetExplorerTrees, syncExplorerTree } from "../../electron/explorerTree";
import type { CallStudioTool } from "../../electron/studioQueries";
import {
  applyExplorerUpdates,
  type ExplorerNode,
  type ExplorerTree,
  emptyExplorerTree,
} from "../../src/lib/explorer";

interface FakeObject {
  name: string;
  className?: string;
  children?: FakeObject[];
}

const folder = (name: string, ...children: FakeObject[]): FakeObject => ({
  name,
  className: "Folder",
  children,
});
const many = (count: number, make: (index: number) => FakeObject) =>
  Array.from({ length: count }, (_, index) => make(index));

interface FakeStudio {
  place: FakeObject[];
  /** What the watcher's marker says, or null when there's no watcher. */
  version: string | null;
}

/** Answers as Studio does: a level at a time, a path reaches only the first object with it. */
function fakeStudio(studio: FakeStudio) {
  return vi.fn<CallStudioTool>(async (name, args) => {
    if (name === "inspect_instance") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              properties:
                studio.version === null
                  ? {}
                  : { Value: `false ${Math.floor(Date.now() / 1000)} ${studio.version}` },
            }),
          },
        ],
      };
    }
    const maxDepth = Number(args.max_depth);
    const limit = Number(args.head_limit);
    const start: { object: FakeObject; path: string; parent: string }[] = [];
    if (typeof args.path === "string") {
      let objects = studio.place;
      let found: FakeObject | undefined;
      for (const segment of args.path.split(".")) {
        found = objects.find((object) => object.name === segment);
        if (!found) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Could not find instance at path '${args.path}'`,
              },
            ],
          };
        }
        objects = found.children ?? [];
      }
      start.push({
        object: found as FakeObject,
        path: args.path,
        parent: args.path.split(".").at(-2) ?? "Obby",
      });
    }
    const rows: object[] = [];
    if (start.length === 0) {
      rows.push({ fullPath: "Obby", name: "Obby", className: "DataModel" });
      for (const object of studio.place) {
        start.push({ object, path: object.name, parent: "Obby" });
      }
    }
    let level = start;
    let depth = args.path ? 0 : 1;
    while (level.length > 0 && depth <= maxDepth) {
      const next: typeof level = [];
      for (const { object, path, parent } of level) {
        const children = object.children ?? [];
        rows.push({
          fullPath: path,
          name: object.name,
          parentName: parent,
          className: object.className ?? "Folder",
          ...(depth === maxDepth && children.length > 0
            ? { unexploredChildCount: children.length }
            : {}),
        });
        if (depth < maxDepth) {
          for (const child of children) {
            next.push({ object: child, path: `${path}.${child.name}`, parent: object.name });
          }
        }
      }
      level = next;
      depth += 1;
    }
    const cut = rows.length > limit;
    const text = JSON.stringify(cut ? rows.slice(0, limit) : rows);
    return {
      content: [
        {
          type: "text" as const,
          text: cut
            ? `Note: Output limited to ${limit} nodes (results truncated)\n\n${text}`
            : text,
        },
      ],
    };
  });
}

/** Syncs the way the renderer does, and hands back its tree and what arrived. */
function renderer(callTool: CallStudioTool) {
  let tree: ExplorerTree = emptyExplorerTree();
  const sync = async (options: { fresh?: boolean; force?: boolean } = {}) => {
    let updates = 0;
    const result = await syncExplorerTree(callTool, "studio-1", {
      fresh: options.fresh ?? tree.roots.length === 0,
      force: options.force ?? false,
      onUpdate: (update) => {
        updates += 1;
        tree = applyExplorerUpdates(tree, [update]);
      },
    });
    return { result, updates };
  };
  return { sync, tree: () => tree };
}

const child = (nodes: readonly ExplorerNode[], name: string) => {
  const found = nodes.find((node) => node.name === name);
  if (!found) throw new Error(`No ${name} in ${nodes.map((node) => node.name).join(", ")}`);
  return found;
};
const treeReads = (callTool: ReturnType<typeof fakeStudio>) =>
  callTool.mock.calls.filter(([name]) => name === "search_game_tree").map(([, args]) => args);

describe("syncExplorerTree", () => {
  beforeEach(() => resetExplorerTrees());

  it("reads the place name and only the services people see", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder("Workspace", folder("Model", folder("Part"))),
        folder("CoreGui", folder("Hidden")),
        folder("Lighting"),
      ],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    expect(tree().placeName).toBe("Obby");
    expect(
      tree()
        .roots.map((root) => root.name)
        .sort(),
    ).toEqual(["Lighting", "Workspace"]);
    expect(child(child(tree().roots, "Workspace").children, "Model").children[0]?.path).toBe(
      "game.Workspace.Model.Part",
    );
    // A service with nothing in it takes no read of its own, nor does a hidden one.
    expect(treeReads(callTool).map((args) => args.path)).toEqual([undefined, "Workspace"]);
  });

  it("gives every one of more than 20 same-named objects its own children", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder(
          "Workspace",
          ...many(25, (index) =>
            folder("Twin", ...many(index % 3, (k) => folder(`Kid${index}_${k}`))),
          ),
        ),
      ],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    const twins = child(tree().roots, "Workspace").children;
    expect(twins).toHaveLength(25);
    // Sorted by name, which leaves objects sharing one in Studio's order.
    twins.forEach((twin, index) => {
      expect(twin.occurrence).toBe(index);
      expect(twin.occurrences).toBe(25);
      expect(twin.id).toBe(`game.Workspace.Twin${index > 0 ? `#${index}` : ""}`);
      expect(twin.children.map((kid) => kid.name)).toEqual(
        many(index % 3, (k) => folder(`Kid${index}_${k}`)).map((kid) => kid.name),
      );
    });
  });

  it("keeps children of twins apart when they share names, and nested twins too", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder(
          "Workspace",
          folder("Twin", folder("Same", folder("A")), folder("Other")),
          folder("Twin", folder("Same", folder("B"), folder("C"))),
        ),
      ],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    const [first, second] = child(tree().roots, "Workspace").children;
    expect(first?.children.map((kid) => kid.name)).toEqual(["Other", "Same"]);
    expect(second?.children.map((kid) => kid.name)).toEqual(["Same"]);
    expect(child(first?.children ?? [], "Same").children.map((kid) => kid.name)).toEqual(["A"]);
    expect(child(second?.children ?? [], "Same").children.map((kid) => kid.name)).toEqual([
      "B",
      "C",
    ]);
  });

  it("reads through a name with a period in it, which a path can't reach", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [folder("Workspace", folder("Dot.Name", folder("Inner", folder("Deep"))))],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    const dotted = child(child(tree().roots, "Workspace").children, "Dot.Name");
    expect(child(child(dotted.children, "Inner").children, "Deep").path).toBe(
      "game.Workspace.Dot.Name.Inner.Deep",
    );
  });

  it("reads a big place in short reads, none of them listing everything", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder(
          "Workspace",
          folder(
            "Big",
            ...many(40, (a) =>
              folder(
                `A${a}`,
                ...many(20, (b) => folder(`B${b}`, ...many(20, (c) => folder(`C${c}`)))),
              ),
            ),
          ),
        ),
      ],
    });
    const { sync, tree } = renderer(callTool);
    const seen: number[] = [];
    callTool.mock.results.length = 0;
    const { updates, result } = await sync();

    for (const { value } of callTool.mock.results) {
      const answer = await value;
      const text = answer.content[0].text as string;
      if (!text.includes("Output limited") && text.startsWith("[")) {
        seen.push(JSON.parse(text).length);
      }
    }
    expect(Math.max(...seen)).toBeLessThan(3_001);
    expect(updates).toBeGreaterThan(40);
    expect(result.truncated).toBe(false);
    expect(tree().byId.size).toBe(2 + 40 + 800 + 16_000);
  });

  it("settles a folder of big same-named objects with one long read, not a dead end", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder(
          "Workspace",
          ...many(4, () => folder("Tree", ...many(1_000, (k) => folder(`L${k}`)))),
        ),
      ],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    expect(tree().byId.size).toBe(1 + 4 + 4_000);
    for (const twin of child(tree().roots, "Workspace").children) {
      expect(twin.children).toHaveLength(1_000);
    }
  });

  it("copes with a folder of tens of thousands of objects that each hold something", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [folder("Workspace", ...many(20_000, (index) => folder(`M${index}`, folder("Kid"))))],
    });
    const { sync, tree } = renderer(callTool);
    const startedAt = performance.now();
    await sync();

    expect(tree().byId.size).toBe(1 + 40_000);
    // Quadratic work here would take many seconds and block the whole app.
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("carries on below Studio's depth limit", async () => {
    let deepest = folder("L15");
    for (let level = 14; level >= 1; level -= 1) deepest = folder(`L${level}`, deepest);
    const callTool = fakeStudio({ version: null, place: [folder("Workspace", deepest)] });
    const { sync, tree } = renderer(callTool);
    await sync();

    let nodes = child(tree().roots, "Workspace").children;
    for (let level = 1; level <= 15; level += 1) {
      const node = child(nodes, `L${level}`);
      expect(node.pending).not.toBe(true);
      nodes = node.children;
    }
  });

  it("offers no arrow on what nothing can reach, below an object sharing a path", async () => {
    let deepest = folder("L12", folder("Unreachable"));
    for (let level = 11; level >= 1; level -= 1) deepest = folder(`L${level}`, deepest);
    const callTool = fakeStudio({
      version: null,
      place: [folder("Workspace", folder("Twin"), folder("Twin", deepest))],
    });
    const { sync, tree } = renderer(callTool);
    await sync();

    let node = child(child(tree().roots, "Workspace").children, "Twin");
    node = child(tree().roots, "Workspace").children[1] as ExplorerNode;
    for (let level = 1; level <= 8; level += 1) node = child(node.children, `L${level}`);
    let last = node;
    while (last.children[0]) last = last.children[0];
    expect(last.hasChildren).toBe(false);
    expect(last.pending).not.toBe(true);
  });

  describe("when nothing has changed", () => {
    const place = () => [
      folder("Workspace", folder("Model", folder("Part")), folder("Other", folder("Thing"))),
    ];

    it("only asks, when Studio's watcher says when the tree changes", async () => {
      const callTool = fakeStudio({ version: "7", place: place() });
      const { sync } = renderer(callTool);
      await sync();
      callTool.mockClear();

      const { result, updates } = await sync();

      expect(result).toMatchObject({ changed: false, watching: true });
      expect(updates).toBe(0);
      expect(treeReads(callTool)).toHaveLength(1);
    });

    it("reads again if the watcher's count moves, sending only what changed", async () => {
      const studio: FakeStudio = { version: "7", place: place() };
      const callTool = fakeStudio(studio);
      const { sync, tree } = renderer(callTool);
      await sync();

      const workspace = studio.place[0] as FakeObject;
      (workspace.children?.[0] as FakeObject).name = "Renamed";
      studio.version = "8";
      const { result, updates } = await sync();

      expect(result.changed).toBe(true);
      expect(updates).toBe(1);
      const workspaceNode = child(tree().roots, "Workspace");
      expect(workspaceNode.children.map((node) => node.name)).toEqual(["Other", "Renamed"]);
      expect(child(workspaceNode.children, "Renamed").children[0]?.id).toBe(
        "game.Workspace.Renamed.Part",
      );
    });

    it("reads but sends nothing without a watcher", async () => {
      const callTool = fakeStudio({ version: null, place: place() });
      const { sync } = renderer(callTool);
      await sync();
      callTool.mockClear();

      const { result, updates } = await sync();

      expect(result).toMatchObject({ changed: false, watching: false });
      expect(updates).toBe(0);
      expect(treeReads(callTool).length).toBeGreaterThan(1);
    });

    it("reads when asked to, right after an edit the watcher hasn't counted yet", async () => {
      const studio: FakeStudio = { version: "7", place: place() };
      const callTool = fakeStudio(studio);
      const { sync, tree } = renderer(callTool);
      await sync();

      const model = (studio.place[0] as FakeObject).children?.[0] as FakeObject;
      model.children?.push(folder("New"));
      expect((await sync()).updates).toBe(0);
      expect((await sync({ force: true })).updates).toBeGreaterThan(0);
      expect(
        child(child(child(tree().roots, "Workspace").children, "Model").children, "New"),
      ).toBeDefined();
    });

    it("notices a child moving between twins, which looks the same in the rows", async () => {
      const left = folder("Twin", folder("Kid"));
      const right = folder("Twin");
      const studio: FakeStudio = { version: "1", place: [folder("Workspace", left, right)] };
      const { sync, tree } = renderer(fakeStudio(studio));
      await sync();

      right.children = left.children;
      left.children = [];
      studio.version = "2";
      await sync();

      const [first, second] = child(tree().roots, "Workspace").children;
      expect(first?.children).toHaveLength(0);
      expect(second?.children.map((kid) => kid.name)).toEqual(["Kid"]);
    });

    it("drops objects that were removed", async () => {
      const studio: FakeStudio = { version: "1", place: place() };
      const { sync, tree } = renderer(fakeStudio(studio));
      await sync();

      (studio.place[0] as FakeObject).children?.shift();
      studio.version = "2";
      await sync();

      expect(tree().byId.has("game.Workspace.Model")).toBe(false);
      expect(tree().byId.has("game.Workspace.Model.Part")).toBe(false);
      expect(tree().byId.has("game.Workspace.Other.Thing")).toBe(true);
    });
  });

  it("keeps what's there while a part is on its way, then replaces it", () => {
    const part = {
      name: "Part",
      className: "Part",
      path: "game.W.M.Part",
      hasChildren: false,
      children: [],
    };
    const model = {
      name: "M",
      className: "Model",
      path: "game.W.M",
      hasChildren: true,
      children: [part],
    };
    const world = {
      name: "W",
      className: "Workspace",
      path: "game.W",
      hasChildren: true,
      children: [model],
    };
    let tree = applyExplorerUpdates(emptyExplorerTree(), [{ parentId: null, children: [world] }]);

    tree = applyExplorerUpdates(tree, [
      {
        parentId: "game.W",
        children: [{ ...model, children: [], pending: true }],
      },
    ]);
    expect(tree.byId.has("game.W.M.Part")).toBe(true);

    tree = applyExplorerUpdates(tree, [{ parentId: "game.W.M", children: [] }]);
    expect(tree.byId.has("game.W.M.Part")).toBe(false);

    // An update for something that's gone is dropped.
    tree = applyExplorerUpdates(tree, [{ parentId: "game.Gone", children: [part] }]);
    expect(tree.byId.has("game.W.M.Part")).toBe(false);
  });

  it("falls back through the data models during a playtest", async () => {
    const callTool = vi.fn<CallStudioTool>(async (name, args) => {
      if (name === "inspect_instance") return { content: [{ type: "text" as const, text: "{}" }] };
      if (args.datamodel_type === "Edit") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Edit is not available in Play mode" }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify([
              { fullPath: "Workspace", name: "Workspace", className: "Workspace" },
            ]),
          },
        ],
      };
    });
    const { sync, tree } = renderer(callTool);
    const { result } = await sync();

    expect(result.watching).toBe(false);
    expect(tree().roots[0]?.name).toBe("Workspace");
    expect(treeReads(callTool as never).at(-1)?.datamodel_type).toBe("Server");
  });

  it("reports Studio's reasons when no data model answers, leaving out repeats", async () => {
    const callTool = vi.fn<CallStudioTool>(async (name, args) => {
      if (name === "inspect_instance") return { content: [{ type: "text" as const, text: "{}" }] };
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: args.datamodel_type === "Edit" ? "Studio is busy" : "not available in Edit mode",
          },
        ],
      };
    });
    await expect(renderer(callTool).sync()).rejects.toThrow(/^Studio is busy$/);
  });

  it("says when Studio's answer can't be used", async () => {
    const callTool = vi.fn<CallStudioTool>(async () => ({
      content: [{ type: "text" as const, text: "No Studio connected" }],
    }));
    await expect(renderer(callTool).sync()).rejects.toThrow("unreadable");
  });

  it("stops when a newer read replaces it", async () => {
    const callTool = fakeStudio({
      version: null,
      place: [
        folder("Workspace", ...many(30, (index) => folder(`F${index}`, folder("Kid")))),
        ...["Lighting", "ReplicatedStorage", "StarterGui"].map((name) =>
          folder(name, folder("Kid")),
        ),
      ],
    });
    const controller = new AbortController();
    controller.abort();
    const updates = vi.fn();
    const { complete } = await syncExplorerTree(callTool, "studio-1", {
      fresh: true,
      force: false,
      signal: controller.signal,
      onUpdate: updates,
    });

    expect(complete).toBe(false);
    expect(treeReads(callTool)).toHaveLength(1);
  });
});
