import { describe, expect, it } from "vitest";
import {
  canEditObject,
  colorFromHex,
  colorToHex,
  type ExplorerNode,
  explorerRows,
  fieldOptions,
  formatFieldValue,
  groupFields,
  hexToHsv,
  hsvToHex,
  isAttributeName,
  keepExactNumbers,
  objectPaths,
  readableFieldValue,
  shortenNumber,
  siblingPath,
} from "@/lib/explorer";
import { isVisibleSession } from "@/lib/sessionVisibility";

const snapshot = {
  placeName: "Obby Prototype",
  capturedAt: "2026-07-27T12:00:00Z",
  roots: [
    {
      name: "Workspace",
      className: "Workspace",
      path: "game.Workspace",
      hasChildren: true,
      properties: [{ name: "StreamingEnabled", value: "false" }],
      attributes: [],
      children: [
        {
          name: "SpawnLocation",
          className: "SpawnLocation",
          path: "game.Workspace.SpawnLocation",
          hasChildren: false,
          properties: [
            { name: "Position", value: "0, 4, 0" },
            { name: "Anchored", value: "true" },
          ],
          attributes: [{ name: "Team", value: "Lobby" }],
          children: [],
        },
      ],
    },
  ],
};

describe("Explorer data boundary", () => {
  it("keeps private Explorer sessions out of the chat list", () => {
    expect(isVisibleSession({ metadata: { bloxbotHidden: true } } as never)).toBe(false);
    expect(isVisibleSession({ metadata: {} } as never)).toBe(true);
  });

  it("only offers edits on objects Roblox lets you change", () => {
    const [workspace] = snapshot.roots;
    const [spawn] = workspace.children;
    expect(canEditObject(workspace)).toBe(false);
    expect(canEditObject(spawn)).toBe(true);
    expect(
      canEditObject({
        ...spawn,
        name: "Terrain",
        className: "Terrain",
        path: "game.Workspace.Terrain",
      }),
    ).toBe(false);
  });

  it("shortens float noise without touching numbers people wrote", () => {
    expect(shortenNumber("0.30000001192092896")).toBe("0.3");
    expect(shortenNumber("90.00000000000001")).toBe("90");
    expect(shortenNumber("8.742277657347586e-15")).toBe("0");
    expect(shortenNumber("0.00012345")).toBe("1.23e-4");
    expect(shortenNumber("1.25")).toBe("1.25");
    expect(shortenNumber("2048")).toBe("2048");
    expect(shortenNumber("-0")).toBe("0");
    expect(
      readableFieldValue({ name: "Size", value: "0.30000001192092896, 4, 1.5", numeric: true }),
    ).toBe("0.3, 4, 1.5");
  });

  it("leaves text alone even when it looks like a number or an enum", () => {
    const text = { name: "Value", type: "string" };
    expect(formatFieldValue({ ...text, value: "0.30000001192092896" })).toBe("0.30000001192092896");
    expect(formatFieldValue({ ...text, value: "Enum.PartType.Block" })).toBe("Enum.PartType.Block");
  });

  it("reads each type the way Studio's properties panel does", () => {
    expect(
      formatFieldValue({ name: "Shape", type: "EnumItem", value: "Enum.PartType.Block" }),
    ).toBe("Block");
    expect(
      formatFieldValue({
        name: "CFrame",
        type: "CFrame",
        value: "1.5, 2, 3, 0, 90, 0",
        numeric: true,
      }),
    ).toBe("1.5, 2, 3");
    expect(
      formatFieldValue({ name: "Color", type: "Color3", value: "1, 0.5, 0", numeric: true }),
    ).toBe("255, 128, 0");
    expect(formatFieldValue({ name: "PrimaryPart", type: "Instance", value: "" })).toBe("None");
  });

  it("converts between the wheel's colors and hex without drifting", () => {
    for (const hex of [
      "#ff0000",
      "#00ff00",
      "#0000ff",
      "#ffffff",
      "#000000",
      "#5b5b5b",
      "#c4281c",
    ]) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
    expect(hexToHsv("#ff0000")).toEqual({ hue: 0, saturation: 1, value: 1 });
    expect(hexToHsv("#00ff00").hue).toBe(120);
  });

  it("round-trips colors through the color picker's format", () => {
    expect(colorToHex("1, 0.5, 0")).toBe("#ff8000");
    expect(colorFromHex("#ff0000")).toBe("1, 0, 0");
  });

  it("puts the categories people use most first", () => {
    const field = (category: string) => ({ name: category, value: "1", category });
    expect(
      groupFields([field("Zebra"), field("Transform"), field("Appearance")]).map(
        ({ category }) => category,
      ),
    ).toEqual(["Appearance", "Transform", "Zebra"]);
  });

  it("offers fixed choices for booleans, Faces and Axes, and Studio's for enums", () => {
    expect(fieldOptions({ name: "Anchored", value: "true", type: "boolean" })).toEqual([
      "true",
      "false",
    ]);
    expect(fieldOptions({ name: "Axes", value: "X", type: "Axes" })).toEqual(["X", "Y", "Z"]);
    expect(
      fieldOptions({ name: "Shape", value: "Block", type: "EnumItem", options: ["Ball"] }),
    ).toEqual(["Ball"]);
  });

  it("knows Roblox's rule for attribute names", () => {
    expect(isAttributeName("Speed_2")).toBe(true);
    expect(isAttributeName("has space")).toBe(false);
    expect(isAttributeName("RBX_Thing")).toBe(false);
    expect(isAttributeName("")).toBe(false);
  });

  it("finds a sibling's path when a name has a period in it", () => {
    const dotted = { ...snapshot.roots[0].children[0], name: "A.B", path: "game.Workspace.A.B" };
    expect(siblingPath(dotted, "C")).toBe("game.Workspace.C");
  });
});

describe("explorerRows", () => {
  const node = (name: string, children: ExplorerNode[] = [], pending = false) => ({
    name,
    className: "Folder",
    path: `game.${name}`,
    hasChildren: children.length > 0 || pending,
    ...(pending ? { pending } : {}),
    children,
  });

  it("lists what's expanded, with where each row sits", () => {
    const rows = explorerRows(
      [node("A", [node("B"), node("C")]), node("D", [node("E")])],
      new Set(["game.A"]),
    );
    expect(
      rows.map(({ node: row, depth, position, siblings }) => [row.name, depth, position, siblings]),
    ).toEqual([
      ["A", 0, 1, 2],
      ["B", 1, 1, 2],
      ["C", 1, 2, 2],
      ["D", 0, 2, 2],
    ]);
  });

  it("shows a loading row for children still on their way", () => {
    const rows = explorerRows([node("A", [], true)], new Set(["game.A"]));
    expect(rows[1]).toMatchObject({ depth: 1, loading: true });
  });
});

describe("what the review found", () => {
  it("keeps colors brighter than Studio's range to a real hex value", () => {
    expect(colorToHex("2, 0, 0")).toBe("#ff0000");
    expect(colorToHex("-1, 0.5, 0")).toBe("#008000");
  });

  it("only offers objects a path can name", () => {
    const leaf = (name: string, extra = {}) => ({
      name,
      className: "Part",
      path: `game.${name}`,
      hasChildren: false,
      children: [],
      ...extra,
    });
    const twin = { occurrence: 0, occurrences: 2 };
    expect(
      objectPaths([
        leaf("Solo"),
        leaf("Twin", { ...twin, children: [leaf("Twin.Inside")] }),
        leaf("Twin", { ...twin, occurrence: 1 }),
      ]),
    ).toEqual(["game.Solo"]);
  });

  it("keeps every digit of the numbers an edit left alone", () => {
    const field = {
      name: "Size",
      value: "0 0.1234567 0 1 0.9876543 0",
      type: "NumberSequence",
      numeric: true,
    };
    const shown = readableFieldValue(field);
    expect(shown).toBe("0 0.123 0 1 0.988 0");
    expect(keepExactNumbers("0 0.5 0 1 0.988 0", field)).toBe("0 0.5 0 1 0.9876543 0");
    // A keypoint added can't be matched up, so what was typed stands.
    expect(keepExactNumbers("0 0.123 0 0.5 1 0 1 0.988 0", field)).toBe(
      "0 0.123 0 0.5 1 0 1 0.988 0",
    );
  });
});
