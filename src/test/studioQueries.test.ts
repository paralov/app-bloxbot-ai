import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CallStudioTool,
  discoverStudioTargets,
  editExplorerObject,
  inspectExplorerNode,
  readHistoryState,
  resetStudioCaches,
  selectStudioTarget,
} from "../../electron/studioQueries";

const json = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const failure = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

beforeEach(() => resetStudioCaches());

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
  describe("reading an object's details", () => {
    const REFLECTION = {
      classes: {
        Instance: [
          false,
          [
            ["Parent", "Instance", false, true, "Data"],
            ["Archivable", "boolean", false, true, "Behavior"],
          ],
        ],
        BasePart: [
          "Instance",
          [
            ["Position", "Vector3", false, true, "Transform"],
            ["Orientation", "Vector3", false, true, "Transform"],
            ["CFrame", "CFrame", false, true, "Transform"],
            ["Color", "Color3", false, true, "Appearance"],
            ["BrickColor", "BrickColor", false, true, "Appearance"],
            ["Material", "EnumItem", "Material", true, "Appearance"],
            ["CustomPhysicalProperties", "PhysicalProperties", false, true, "Part"],
            ["Capabilities", "SecurityCapabilities", false, true, "Permissions"],
          ],
        ],
        Part: ["BasePart", []],
        TextLabel: ["Instance", [["FontFace", "Font", false, true, "Text"]]],
        ObjectValue: ["Instance", [["Value", "Instance", false, true, "Data"]]],
        Lighting: ["Instance", [["Brightness", "number", false, true, "Appearance"]]],
      },
      enums: { Material: ["Plastic", "Neon"] },
      brickColors: [["Bright red", "#c4281c"]],
      next: false,
    };
    const part = {
      name: "Part",
      className: "Part",
      properties: {
        Archivable: true,
        "CFrame.Position": "1, 2, 3",
        "CFrame.Rotation": "0, 0, 1, 0, 1, 0, -1, 0, 0",
        "PivotOffset.Position": "0, 1, 0",
        "PivotOffset.Rotation": "1, 0, 0, 0, 1, 0, 0, 0, 1",
        Color: "1, 0.5, 0",
        BrickColor: "Bright red",
        Material: "Enum.Material.Plastic",
        Capabilities: "",
        UniqueId: "abc",
      },
      attributes: {
        Speed: 2,
        Fly: true,
        Note: "1, 2, 3",
        Spot: { Position: "1, 2, 3", Rotation: "1, 0, 0, 0, 1, 0, 0, 0, 1" },
      },
    };
    // By default Studio has something to redo, so reads must stay away from scripts.
    const historyState = (canRedo: boolean, seconds = Date.now() / 1000) => ({
      properties: { Value: `${canRedo} ${Math.floor(seconds)} 0` },
    });
    const studio = (match: unknown, script?: unknown, history: unknown = historyState(true)) =>
      vi.fn<CallStudioTool>(async (name, args) => {
        if (name === "inspect_instance") {
          return args.path === "CoreGui.BloxBotHistoryState" ? json(history) : json(match);
        }
        return String(args.code).includes("GetClasses") ? json(REFLECTION) : json(script);
      });
    const request = { path: "game.Workspace.Part", className: "Part" };
    // Class data takes a script, so reads that won't run one rely on an earlier selection's.
    beforeEach(async () => {
      await inspectExplorerNode(
        studio(part, { properties: [], attributes: [] }, historyState(false)),
        "studio-1",
        request,
      );
    });
    const scripts = (callTool: ReturnType<typeof studio>) =>
      callTool.mock.calls.filter(
        ([name, args]) => name === "execute_luau" && !String(args.code).includes("GetClasses"),
      );

    describe("choosing how to read", () => {
      const scripted = {
        properties: [
          { name: "Mass", value: "5.6", type: "number", writable: false, category: "Part" },
          { name: "Anchored", value: "true", type: "boolean", writable: true, category: "Part" },
        ],
        attributes: [{ name: "Tint", value: "1, 0, 0", type: "Color3", writable: true }],
        tags: ["Enemy", "Boss"],
        placeTags: ["Enemy", "Boss", "Coin"],
      };

      it("reads everything with a script when there's nothing to redo", async () => {
        const callTool = studio(part, scripted, historyState(false));
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(scripts(callTool)).toHaveLength(1);
        expect(details?.limited).toBeUndefined();
        expect(details?.properties.map((f) => f.name)).toEqual(["Anchored", "Mass"]);
        expect(details?.attributes[0]).toMatchObject({ type: "Color3", numeric: true });
        expect(details?.tags).toEqual(["Boss", "Enemy"]);
        expect(details?.placeTags).toEqual(["Boss", "Coin", "Enemy"]);
      });

      it("won't run a script when there's something to redo, and says values are missing", async () => {
        const callTool = studio(part, scripted, historyState(true));
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(scripts(callTool)).toHaveLength(0);
        expect(details?.limited).toBe("redo");
        expect(details?.tags).toBeUndefined();
      });

      it("starts the watcher when it's missing or stopped, then reads with a script", async () => {
        const stopped = historyState(false, Date.now() / 1000 - 60);
        const callTool = studio(part, scripted, stopped);
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(
          scripts(callTool).map(([, args]) => String(args.code).includes("GetCanRedo")),
        ).toEqual([true, false]);
        expect(details?.properties.map((f) => f.name)).toEqual(["Anchored", "Mass"]);
      });

      it("doesn't start anything when reading again by itself", async () => {
        const callTool = studio(part, scripted, { properties: {} });
        const details = await inspectExplorerNode(callTool, "studio-1", {
          ...request,
          background: true,
        });

        expect(scripts(callTool)).toHaveLength(0);
        expect(details).toBeNull();
      });

      it("doesn't touch class data in the background either, even when it's missing", async () => {
        resetStudioCaches();
        const nothingToRedo = await inspectExplorerNode(
          studio(part, scripted, historyState(true)),
          "studio-1",
          { ...request, background: true },
        );
        const callTool = studio(part, scripted, { properties: {} });
        await inspectExplorerNode(callTool, "studio-1", { ...request, background: true });

        expect(callTool.mock.calls.filter(([name]) => name === "execute_luau")).toHaveLength(0);
        expect(nothingToRedo?.limited).toBe("redo");
      });

      it("won't read class data when there's something to redo", async () => {
        resetStudioCaches();
        const callTool = studio(part, scripted, historyState(true));
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(callTool.mock.calls.filter(([name]) => name === "execute_luau")).toHaveLength(0);
        expect(details?.properties.find((f) => f.name === "Archivable")).toMatchObject({
          value: "true",
          writable: false,
        });
      });

      it("still reads an object when class data can't be read", async () => {
        resetStudioCaches();
        const callTool = vi.fn<CallStudioTool>(async (name, args) => {
          if (name === "inspect_instance") {
            return args.path === "CoreGui.BloxBotHistoryState"
              ? json(historyState(false))
              : json(part);
          }
          return String(args.code).includes("GetClasses")
            ? failure("Studio is busy")
            : json(scripted);
        });

        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(details?.properties.map((f) => f.name)).toEqual(["Anchored", "Mass"]);
      });

      it("stops reading class data if something becomes redoable partway", async () => {
        resetStudioCaches();
        let canRedo = false;
        let pages = 0;
        const callTool = vi.fn<CallStudioTool>(async (name, args) => {
          if (name === "inspect_instance") {
            return args.path === "CoreGui.BloxBotHistoryState"
              ? json(historyState(canRedo))
              : json(part);
          }
          if (!String(args.code).includes("GetClasses")) return json(scripted);
          pages += 1;
          // The user undoes something while the first page is being read.
          canRedo = true;
          return json({ ...REFLECTION, next: 100 });
        });

        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(pages).toBe(1);
        expect(scripts(callTool)).toHaveLength(0);
        expect(details?.limited).toBe("redo");
      });

      it("offers the BrickColor palette for attributes too", async () => {
        const callTool = studio(
          part,
          {
            ...scripted,
            attributes: [{ name: "Team", value: "Bright red", type: "BrickColor", writable: true }],
          },
          historyState(false),
        );
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(details?.attributes[0]).toMatchObject({
          options: ["Bright red"],
          swatches: ["#c4281c"],
        });
      });

      it("says why values are missing when a script failed", async () => {
        const callTool = vi.fn<CallStudioTool>(async (name, args) => {
          if (name === "inspect_instance") {
            return args.path === "CoreGui.BloxBotHistoryState"
              ? json(historyState(false))
              : json(part);
          }
          return failure("Studio is busy");
        });
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(details?.limited).toBe("failed");
      });

      it("reads the watcher's count of tree changes", async () => {
        const seconds = Math.floor(Date.now() / 1000);
        const answer = async () => json({ properties: { Value: `false ${seconds} 12` } });
        await expect(readHistoryState(answer, "studio-1")).resolves.toEqual({
          redo: "nothing-to-redo",
          treeVersion: "12",
        });
      });

      it("falls back to what it can read if the script fails", async () => {
        const callTool = vi.fn<CallStudioTool>(async (name, args) => {
          if (name === "inspect_instance") {
            return args.path === "CoreGui.BloxBotHistoryState"
              ? json(historyState(false))
              : json(part);
          }
          return String(args.code).includes("GetClasses")
            ? json(REFLECTION)
            : failure("Studio is busy");
        });
        const details = await inspectExplorerNode(callTool, "studio-1", request);

        expect(details?.properties.find((f) => f.name === "Archivable")?.value).toBe("true");
      });
    });

    it("reads through inspect_instance, not a script, which would clear Studio's redo", async () => {
      const callTool = studio(part);
      const details = await inspectExplorerNode(callTool, "studio-1", request);

      expect(scripts(callTool)).toHaveLength(0);
      const field = (name: string) => details?.properties.find((item) => item.name === name);
      expect(field("Archivable")).toMatchObject({ type: "boolean", value: "true", writable: true });
      expect(field("Material")).toMatchObject({
        type: "EnumItem",
        options: ["Plastic", "Neon"],
        writable: true,
      });
      expect(field("BrickColor")).toMatchObject({
        options: ["Bright red"],
        swatches: ["#c4281c"],
      });
      expect(field("Capabilities")?.writable).toBe(false);
      expect(field("UniqueId")).toBeUndefined();
    });

    it("works out Position, Orientation, CFrame and Pivot from what Studio sends", async () => {
      const details = await inspectExplorerNode(studio(part), "studio-1", request);
      const value = (name: string) => details?.properties.find((f) => f.name === name)?.value;

      expect(value("Position")).toBe("1, 2, 3");
      // This rotation is 90 degrees around Y.
      expect(value("Orientation")).toBe("0, 90, 0");
      expect(value("CFrame")).toBe("1, 2, 3, 0, 90, 0");
      expect(value("Pivot")).toBe("1, 3, 3, 0, 90, 0");
    });

    it("takes a Model's pivot from its PrimaryPart, without a script", async () => {
      const model = {
        name: "Car",
        className: "Model",
        properties: {
          PrimaryPart: "Workspace.Car.Body",
          "WorldPivot.Position": "9, 9, 9",
          "WorldPivot.Rotation": "1, 0, 0, 0, 1, 0, 0, 0, 1",
        },
      };
      const body = { name: "Body", properties: part.properties };
      const callTool = vi.fn<CallStudioTool>(async (name, args) => {
        if (name !== "inspect_instance") return json(REFLECTION);
        if (args.path === "CoreGui.BloxBotHistoryState") return json(historyState(true));
        return json(args.path === "Workspace.Car.Body" ? body : model);
      });

      const details = await inspectExplorerNode(callTool, "studio-1", {
        path: "game.Workspace.Car",
        className: "Model",
      });

      expect(details?.properties.find((f) => f.name === "Pivot")?.value).toBe("1, 3, 3, 0, 90, 0");
      const scriptsRun = callTool.mock.calls.filter(
        ([name, args]) => name === "execute_luau" && !String(args.code).includes("GetClasses"),
      );
      expect(scriptsRun).toHaveLength(0);
    });

    it("uses WorldPivot for a Model without a PrimaryPart", async () => {
      const model = {
        name: "Car",
        properties: {
          "WorldPivot.Position": "9, 8, 7",
          "WorldPivot.Rotation": "1, 0, 0, 0, 1, 0, 0, 0, 1",
        },
      };
      const details = await inspectExplorerNode(studio(model), "studio-1", {
        path: "game.Workspace.Car",
        className: "Model",
      });
      expect(details?.properties.find((f) => f.name === "Pivot")?.value).toBe("9, 8, 7, 0, 0, 0");
    });

    it("asks a script for the pivot when the PrimaryPart shares its path, but not in the background", async () => {
      const model = {
        name: "Car",
        properties: {
          PrimaryPart: "Workspace.Car.Body",
          "WorldPivot.Position": "9, 9, 9",
          "WorldPivot.Rotation": "1, 0, 0, 0, 1, 0, 0, 0, 1",
        },
      };
      const scripted = {
        properties: [{ name: "Pivot", value: "1, 1, 1, 0, 0, 0", type: "CFrame", writable: true }],
        attributes: [],
      };
      const callTool = vi.fn<CallStudioTool>(async (name, args) => {
        if (name === "inspect_instance") {
          if (args.path === "CoreGui.BloxBotHistoryState") return json(historyState(true));
          return json(args.path === "Workspace.Car.Body" ? { matches: [{}, {}] } : model);
        }
        return String(args.code).includes("GetClasses") ? json(REFLECTION) : json(scripted);
      });
      const car = { path: "game.Workspace.Car", className: "Model" };

      await expect(
        inspectExplorerNode(callTool, "studio-1", { ...car, background: true }),
      ).resolves.toBeNull();
      expect(scripts(callTool)).toHaveLength(0);

      const details = await inspectExplorerNode(callTool, "studio-1", car);
      expect(details?.properties.find((f) => f.name === "Pivot")?.value).toBe("1, 1, 1, 0, 0, 0");
      expect(scripts(callTool)).toHaveLength(1);
    });

    it("shows nothing set as a row that can be set, and a parent from the path", async () => {
      const details = await inspectExplorerNode(studio(part), "studio-1", request);
      const field = (name: string) => details?.properties.find((f) => f.name === name);

      expect(field("CustomPhysicalProperties")).toMatchObject({ value: "", writable: true });
      expect(field("Parent")).toMatchObject({ value: "game.Workspace", type: "Instance" });
    });

    it("converts fonts and object references to the text the editors use", async () => {
      const label = {
        name: "TextLabel",
        properties: {
          FontFace: "Font { Family = rbxasset://a.json, Weight = Bold, Style = Italic }",
        },
      };
      const font = await inspectExplorerNode(studio(label), "studio-1", {
        path: "game.StarterGui.TextLabel",
        className: "TextLabel",
      });
      expect(font?.properties.find((f) => f.name === "FontFace")?.value).toBe(
        "rbxasset://a.json, Bold, Italic",
      );

      const reference = { name: "Ref", properties: { Value: "Workspace.Part" } };
      const object = await inspectExplorerNode(studio(reference), "studio-1", {
        path: "game.Workspace.Ref",
        className: "ObjectValue",
      });
      expect(object?.properties.find((f) => f.name === "Value")?.value).toBe("game.Workspace.Part");
    });

    it("reads attributes with the types Studio's answer shows", async () => {
      const details = await inspectExplorerNode(studio(part), "studio-1", request);

      expect(details?.attributes.map((a) => [a.name, a.type, a.value])).toEqual([
        ["Fly", "boolean", "true"],
        ["Note", "string", "1, 2, 3"],
        ["Speed", "number", "2"],
        ["Spot", "CFrame", "1, 2, 3, 0, 0, 0"],
      ]);
    });

    it("reads the chosen one of several objects at a path", async () => {
      const matches = {
        matches: [
          { name: "Twin", properties: { Archivable: true } },
          { name: "Twin", properties: { Archivable: false } },
        ],
      };
      const details = await inspectExplorerNode(studio(matches), "studio-1", {
        path: "game.Workspace.Twin",
        className: "Part",
        occurrence: 1,
        occurrences: 2,
      });
      expect(details?.properties.find((f) => f.name === "Archivable")?.value).toBe("false");
    });

    it("only asks Studio for class data once", async () => {
      resetStudioCaches();
      const callTool = studio(part, { properties: [], attributes: [] }, historyState(false));
      await inspectExplorerNode(callTool, "studio-1", request);
      await inspectExplorerNode(callTool, "studio-1", request);

      const reads = callTool.mock.calls.filter(([, args]) =>
        String(args.code).includes("GetClasses"),
      );
      expect(reads).toHaveLength(1);
    });

    it("runs a script for services, which inspect_instance has nothing for", async () => {
      const callTool = studio(
        { name: "Lighting", properties: { UniqueId: "abc" } },
        {
          properties: [{ name: "Brightness", value: "2", type: "number", writable: true }],
          attributes: [],
        },
      );
      const lighting = { path: "game.Lighting", className: "Lighting" };

      await expect(inspectExplorerNode(callTool, "studio-1", lighting)).resolves.toMatchObject({
        properties: [{ name: "Brightness", numeric: true }],
      });
      expect(scripts(callTool)).toHaveLength(1);
    });

    it("won't run a script when reading again by itself", async () => {
      const callTool = studio({ name: "Lighting", properties: { UniqueId: "abc" } });

      await expect(
        inspectExplorerNode(callTool, "studio-1", {
          path: "game.Lighting",
          className: "Lighting",
          background: true,
        }),
      ).resolves.toBeNull();
      expect(scripts(callTool)).toHaveLength(0);
    });
  });

  it("reports Studio's errors and unusable output instead of showing nothing", async () => {
    await expect(discoverStudioTargets(async () => failure("Studio is busy"))).rejects.toThrow(
      "Studio is busy",
    );
  });

  describe("editExplorerObject", () => {
    const target = { path: "game.Workspace.Part", className: "Part" };
    const answer = (name: string): CallStudioTool => vi.fn(async () => json({ name }));
    const code = (callTool: CallStudioTool) => String(vi.mocked(callTool).mock.calls[0][1].code);

    it("renames in the edit data model, with the name kept as text", async () => {
      const callTool = answer('Door"s');
      await expect(
        editExplorerObject(callTool, "studio-1", { ...target, action: "rename", name: 'Door"s' }),
      ).resolves.toEqual({ name: 'Door"s' });

      expect(vi.mocked(callTool).mock.calls[0][0]).toBe("execute_luau");
      expect(vi.mocked(callTool).mock.calls[0][1]).toMatchObject({
        studio_id: "studio-1",
        datamodel_type: "Edit",
      });
      expect(code(callTool)).toContain('instance.Name = "Door\\"s"');
    });

    it("refuses before changing anything when the object isn't exactly one match", async () => {
      const callTool = answer("Part");
      await editExplorerObject(callTool, "studio-1", { ...target, action: "delete" });

      const source = code(callTool);
      const refuses = source.indexOf("if #matches ~= 1 then error");
      const services = source.indexOf('if instance.Parent == game then error("Services');
      expect(refuses).toBeGreaterThan(-1);
      expect(services).toBeGreaterThan(refuses);
      expect(source.indexOf("instance.Parent = nil")).toBeGreaterThan(services);
    });

    it("sets a field through its current type, and allows it on services", async () => {
      const callTool = answer("Lighting");
      await editExplorerObject(callTool, "studio-1", {
        action: "setField",
        kind: "property",
        field: "Brightness",
        value: '2"',
        valueType: "number",
        path: "game.Lighting",
        className: "Lighting",
      });

      const source = code(callTool);
      expect(source).toContain(
        'instance["Brightness"] = valueFromText("number", instance["Brightness"], "2\\"")',
      );
      expect(source).not.toContain("Services can't be changed");
    });

    it("sets attributes with SetAttribute, and won't create a new one", async () => {
      const callTool = answer("Part");
      await editExplorerObject(callTool, "studio-1", {
        ...target,
        action: "setField",
        kind: "attribute",
        field: "Team",
        value: "Red",
        valueType: "string",
      });

      const source = code(callTool);
      expect(source).toContain(
        'instance:SetAttribute("Team", valueFromText(typeof(current), current, "Red"))',
      );
      expect(source.indexOf('error("This attribute is gone")')).toBeLessThan(
        source.indexOf("instance:SetAttribute"),
      );
    });

    it("moves anything with a pivot through PivotTo, which isn't a property", async () => {
      const callTool = answer("Model");
      await editExplorerObject(callTool, "studio-1", {
        path: "game.Workspace.Model",
        className: "Model",
        action: "setField",
        kind: "property",
        field: "Pivot",
        value: "1, 2, 3, 0, 0, 0",
        valueType: "CFrame",
      });
      expect(code(callTool)).toContain(
        'instance:PivotTo(valueFromText("CFrame", instance:GetPivot(), "1, 2, 3, 0, 0, 0"))',
      );
    });

    it("adds an attribute with a default of its type, and won't overwrite one", async () => {
      const callTool = answer("Part");
      await editExplorerObject(callTool, "studio-1", {
        ...target,
        action: "addAttribute",
        field: "Speed",
        valueType: "Vector3",
      });
      const source = code(callTool);
      expect(source).toContain('instance:SetAttribute("Speed", Vector3.zero)');
      expect(source.indexOf('error("This attribute already exists")')).toBeLessThan(
        source.indexOf("instance:SetAttribute"),
      );
    });

    it("adds and removes tags", async () => {
      const adding = answer("Part");
      await editExplorerObject(adding, "studio-1", {
        ...target,
        action: "addTag",
        field: 'Has "Space"',
      });
      expect(code(adding)).toContain('instance:AddTag("Has \\"Space\\"")');

      const removing = answer("Part");
      await editExplorerObject(removing, "studio-1", {
        ...target,
        action: "removeTag",
        field: "Enemy",
      });
      expect(code(removing)).toContain('instance:RemoveTag("Enemy")');
    });

    it("removes an attribute", async () => {
      const callTool = answer("Part");
      await editExplorerObject(callTool, "studio-1", {
        ...target,
        action: "removeAttribute",
        field: "Speed",
      });
      expect(code(callTool)).toContain('instance:SetAttribute("Speed", nil)');
    });

    it("picks the chosen one of several objects, and refuses if the count changed", async () => {
      const callTool = answer("Twin");
      await editExplorerObject(callTool, "studio-1", {
        path: "game.Workspace.Twin",
        className: "Part",
        occurrence: 1,
        occurrences: 2,
        action: "delete",
      });
      const source = code(callTool);
      expect(source).toContain("if #matches ~= 2 then error(");
      expect(source).toContain("local instance = matches[2]");
    });

    it("keeps a duplicate's name within Roblox's limit", async () => {
      const callTool = vi.fn<CallStudioTool>(async () => json({ name: "x" }));
      await editExplorerObject(callTool, "studio-1", {
        action: "duplicate",
        path: "game.Workspace.Part",
        className: "Part",
      });
      const code = String(callTool.mock.calls[0]?.[1].code);
      expect(code).toContain("utf8.offset");
    });

    it("gives a duplicate its own name, so it gets its own row", async () => {
      const callTool = answer("PartCopy");
      await expect(
        editExplorerObject(callTool, "studio-1", { ...target, action: "duplicate" }),
      ).resolves.toEqual({ name: "PartCopy" });
      expect(code(callTool)).toContain('local name = withSuffix("Copy")');
      expect(code(callTool)).toContain("copy.Name = name");
    });

    it("says to stop the playtest instead of editing a copy that won't last", async () => {
      const callTool: CallStudioTool = vi.fn(async () => ({
        isError: true,
        content: [{ type: "text" as const, text: "Edit is not available in Play mode" }],
      }));
      await expect(
        editExplorerObject(callTool, "studio-1", { ...target, action: "delete" }),
      ).rejects.toThrow("Stop the playtest first");
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });
});
