import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_EXPLORER_PROGRAM,
  BUILTIN_STUDIO_TARGET_PROGRAMS,
} from "@/lib/builtinBloxBotPrograms";
import { ExplorerSnapshotSchema } from "@/lib/explorer";
import {
  GeneratedProgramRuntimeError,
  startGeneratedProgramRuntime,
} from "../../electron/services/GeneratedProgramRuntime";

const envelope = (source: string) => ({
  version: 1 as const,
  contract: {
    name: "explorer-snapshot",
    version: "1",
    inputSchemaVersion: "input-v1",
    outputSchemaVersion: "output-v1",
  },
  source,
});

describe("GeneratedProgramRuntime", () => {
  it("compiles TypeScript once and invokes it through the broker capability", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const runtime = startGeneratedProgramRuntime(callTool);
    const source = `
      async function run({ input, callTool }: { input: { depth: number }; callTool: Function }) {
        const result = await callTool("search_game_tree", { depth: input.depth });
        return { result, depth: input.depth };
      }
    `;
    const first = await Effect.runPromise(runtime.compile(envelope(source)));
    const second = await Effect.runPromise(runtime.compile(envelope(source)));
    expect(second).toBe(first);

    await expect(
      Effect.runPromise(runtime.invoke({ artifact: first, input: { depth: 3 } })),
    ).resolves.toMatchObject({
      contract: { outputSchemaVersion: "output-v1" },
      value: { depth: 3, result: { content: [{ type: "text", text: "ok" }] } },
    });
    expect(callTool).toHaveBeenCalledWith("search_game_tree", { depth: 3 });
  });

  it("refuses Studio tools outside the program's read-only allow-list", async () => {
    const callTool = vi.fn();
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(
      runtime.compile(
        envelope(
          `async function run({ callTool }) { return await callTool("execute_luau", { code: "print(1)" }); }`,
        ),
      ),
    );

    const failure = await Effect.runPromise(Effect.flip(runtime.invoke({ artifact, input: {} })));

    expect(failure).toMatchObject({ phase: "tool-contract" });
    expect(failure.message).toContain("explorer-snapshot programs may not call execute_luau");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("allows a tool Studio marks read-only even when programs don't know it yet", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const describeTool = vi.fn(async (name: string) =>
      name === "renamed_tree_tool"
        ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
        : undefined,
    );
    const runtime = startGeneratedProgramRuntime(callTool, describeTool);
    const artifact = await Effect.runPromise(
      runtime.compile(
        envelope(
          `async function run({ callTool }) { await callTool("renamed_tree_tool", {}); return 1; }`,
        ),
      ),
    );

    await expect(Effect.runPromise(runtime.invoke({ artifact, input: {} }))).resolves.toMatchObject(
      { value: 1 },
    );
    expect(callTool).toHaveBeenCalledWith("renamed_tree_tool", {});
  });

  it("accepts OpenCode's prefixed name for an allowed tool and calls Studio's name", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const describeTool = vi.fn(async (name: string) =>
      name === "renamed_tree_tool"
        ? { annotations: { readOnlyHint: true, openWorldHint: false } }
        : undefined,
    );
    const runtime = startGeneratedProgramRuntime(callTool, describeTool);
    const artifact = await Effect.runPromise(
      runtime.compile(
        envelope(
          `async function run({ callTool }) {
            await callTool("roblox-studio_search_game_tree", { depth: 2 });
            await callTool("roblox-studio_renamed_tree_tool", {});
            return 1;
          }`,
        ),
      ),
    );

    await expect(Effect.runPromise(runtime.invoke({ artifact, input: {} }))).resolves.toMatchObject(
      { value: 1 },
    );
    expect(callTool).toHaveBeenNthCalledWith(1, "search_game_tree", { depth: 2 });
    expect(callTool).toHaveBeenNthCalledWith(2, "renamed_tree_tool", {});
    expect(describeTool).toHaveBeenCalledWith("renamed_tree_tool");
  });

  it("refuses a prefixed tool the rule wouldn't allow by Studio's name", async () => {
    const callTool = vi.fn();
    const describeTool = vi.fn(async () => ({
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    }));
    const runtime = startGeneratedProgramRuntime(callTool, describeTool);
    const artifact = await Effect.runPromise(
      runtime.compile(
        envelope(
          `async function run({ callTool }) { return await callTool("roblox-studio_execute_luau", { code: "print(1)" }); }`,
        ),
      ),
    );

    const failure = await Effect.runPromise(Effect.flip(runtime.invoke({ artifact, input: {} })));

    expect(failure).toMatchObject({ phase: "tool-contract" });
    expect(failure.message).toContain("may not call roblox-studio_execute_luau");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("lists the tools a program may call from Studio's list, or its known tools", async () => {
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    const listTools = vi.fn(async () => [
      { name: "search_game_tree", annotations: readOnly },
      { name: "get_studio_state" },
      { name: "script_read", annotations: readOnly },
      { name: "execute_luau", annotations: { readOnlyHint: false } },
      { name: "http_get", annotations: { readOnlyHint: true, openWorldHint: true } },
    ]);
    const runtime = startGeneratedProgramRuntime(vi.fn(), undefined, listTools);
    await expect(Effect.runPromise(runtime.allowedTools("explorer-snapshot"))).resolves.toEqual([
      "search_game_tree",
      "get_studio_state",
      "script_read",
    ]);

    const offline = startGeneratedProgramRuntime(vi.fn(), undefined, async () => {
      throw new Error("Studio is not connected");
    });
    await expect(Effect.runPromise(offline.allowedTools("explorer-snapshot"))).resolves.toEqual([
      "list_roblox_studios",
      "get_studio_state",
      "search_game_tree",
      "inspect_instance",
    ]);
  });

  it("refuses every tool for a contract it doesn't know", async () => {
    const callTool = vi.fn();
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(
      runtime.compile({
        ...envelope(
          `async function run({ callTool }) { return await callTool("list_roblox_studios", {}); }`,
        ),
        contract: { ...envelope("x").contract, name: "unknown-program" },
      }),
    );

    await expect(
      Effect.runPromise(Effect.flip(runtime.invoke({ artifact, input: {} }))),
    ).resolves.toMatchObject({ phase: "tool-contract" });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("restores a compiled function from a persisted artifact", async () => {
    const firstRuntime = startGeneratedProgramRuntime(vi.fn());
    const artifact = await Effect.runPromise(
      firstRuntime.compile(envelope("async function run({ input }) { return input; }")),
    );
    const restoredRuntime = startGeneratedProgramRuntime(vi.fn());

    await expect(
      Effect.runPromise(restoredRuntime.invoke({ artifact, input: { selected: "Workspace" } })),
    ).resolves.toMatchObject({ value: { selected: "Workspace" } });
  });

  it.each([
    ["compile", "import fs from 'node:fs'; async function run() {}"],
    ["compile", "async function run( {"],
  ])("classifies %s failures for regeneration", async (phase, source) => {
    const runtime = startGeneratedProgramRuntime(vi.fn());
    await expect(
      Effect.runPromise(Effect.flip(runtime.compile(envelope(source)))),
    ).resolves.toMatchObject({
      _tag: "GeneratedProgramRuntimeError",
      phase,
      regenerate: true,
    });
  });

  it("classifies broker contract failures for regeneration", async () => {
    const runtime = startGeneratedProgramRuntime(vi.fn().mockRejectedValue(new Error("gone")));
    const artifact = await Effect.runPromise(
      runtime.compile(
        envelope('async function run({ callTool }) { return callTool("search_game_tree", {}); }'),
      ),
    );
    await expect(
      Effect.runPromise(Effect.flip(runtime.invoke({ artifact, input: null }))),
    ).resolves.toMatchObject({
      phase: "tool-contract",
      regenerate: true,
    });
  });

  it("classifies non-serializable output failures for regeneration", async () => {
    const runtime = startGeneratedProgramRuntime(vi.fn());
    const artifact = await Effect.runPromise(
      runtime.compile(envelope("async function run() { return undefined; }")),
    );
    await expect(
      Effect.runPromise(Effect.flip(runtime.invoke({ artifact, input: null }))),
    ).resolves.toMatchObject({
      phase: "output",
      regenerate: true,
    });
  });

  it("uses a typed runtime error", () => {
    expect(
      new GeneratedProgramRuntimeError({
        message: "failed",
        phase: "runtime",
        regenerate: true,
      })._tag,
    ).toBe("GeneratedProgramRuntimeError");
  });

  it("runs the built-in Explorer collector without model repair", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { fullPath: "Place1", name: "Place1", className: "DataModel" },
            {
              fullPath: "Workspace",
              parentName: "Place1",
              name: "Workspace",
              className: "Workspace",
            },
            {
              fullPath: "Workspace.SpawnLocation",
              parentName: "Workspace",
              name: "SpawnLocationClassFallback",
              className: "SpawnLocation",
              properties: { Name: "Player Spawn" },
            },
          ]),
        },
      ],
    });
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(runtime.compile(BUILTIN_EXPLORER_PROGRAM));
    const result = await Effect.runPromise(
      runtime.invoke({ artifact, input: { studioId: "studio-123" } }),
    );
    const snapshot = await Effect.runPromise(
      Schema.decodeUnknown(ExplorerSnapshotSchema)(result.value),
    );

    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots.find((node) => node.name === "Workspace")?.children[0]?.name).toBe(
      "Player Spawn",
    );
    expect(callTool).toHaveBeenCalledWith("search_game_tree", {
      studio_id: "studio-123",
      datamodel_type: "Edit",
      max_depth: 10,
      head_limit: 100_000,
    });
  });

  // Shapes captured from Roblox Studio's MCP on 2026-09-28.
  const studioTree = [
    { fullPath: "Fund or Pass", name: "Fund or Pass", className: "DataModel" },
    {
      parentName: "Fund or Pass",
      fullPath: "Workspace",
      name: "Workspace",
      className: "Workspace",
    },
    {
      parentName: "Fund or Pass",
      fullPath: "ServerScriptService",
      name: "ServerScriptService",
      className: "ServerScriptService",
    },
    {
      parentName: "ServerScriptService",
      fullPath: "ServerScriptService.FundOrPassServer",
      name: "FundOrPassServer",
      className: "Script",
    },
  ];

  async function runExplorer(callTool: ReturnType<typeof vi.fn>) {
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(runtime.compile(BUILTIN_EXPLORER_PROGRAM));
    const result = await Effect.runPromise(
      runtime.invoke({ artifact, input: { studioId: "studio-123" } }),
    );
    return Effect.runPromise(Schema.decodeUnknown(ExplorerSnapshotSchema)(result.value));
  }

  it("reads Studio's tree when a truncation note comes before the JSON", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: `Note: Output limited to 4 nodes (results truncated)\n\n${JSON.stringify(studioTree)}`,
        },
      ],
    });

    const snapshot = await runExplorer(callTool);

    expect(snapshot.placeName).toBe("Fund or Pass");
    expect(snapshot.roots.map((node) => node.name)).toEqual(["Workspace", "ServerScriptService"]);
    expect(snapshot.roots[1]?.children[0]?.name).toBe("FundOrPassServer");
  });

  it("falls back to the server data model when Studio rejects Edit during a playtest", async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: "text", text: "Edit datamodel is not available while playing" }],
      })
      .mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify(studioTree) }] });

    const snapshot = await runExplorer(callTool);

    expect(callTool).toHaveBeenNthCalledWith(
      2,
      "search_game_tree",
      expect.objectContaining({ datamodel_type: "Server" }),
    );
    expect(snapshot.roots).toHaveLength(2);
  });

  it("reports Studio's own error when no data model can be read", async () => {
    const callTool = vi.fn().mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "Studio is not responding" }],
    });
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(runtime.compile(BUILTIN_EXPLORER_PROGRAM));

    const failure = await Effect.runPromise(
      Effect.flip(runtime.invoke({ artifact, input: { studioId: "studio-123" } })),
    );
    // The message itself carries Studio's text, since only it crosses the IPC bridge.
    expect(failure.message).toBe("Generated program execution failed: Studio is not responding");
  });

  it("discovers Place IDs and verifies targets without mutating active Studio state", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            studios: [
              { studio_id: "studio-123", place_id: 987654, name: "Dungeon" },
              { studio_id: " studio-local ", place_id: "   ", name: "Local File" },
            ],
          }),
        },
      ],
    });
    const runtime = startGeneratedProgramRuntime(callTool);
    const discoveryArtifact = await Effect.runPromise(
      runtime.compile(BUILTIN_STUDIO_TARGET_PROGRAMS.discovery),
    );
    const selectionArtifact = await Effect.runPromise(
      runtime.compile(BUILTIN_STUDIO_TARGET_PROGRAMS.selection),
    );

    const discovery = await Effect.runPromise(
      runtime.invoke({ artifact: discoveryArtifact, input: {} }),
    );
    const selection = await Effect.runPromise(
      runtime.invoke({ artifact: selectionArtifact, input: { targetKey: "studio-123" } }),
    );
    const localSelection = await Effect.runPromise(
      runtime.invoke({ artifact: selectionArtifact, input: { targetKey: "studio-local" } }),
    );

    expect(discovery.value).toMatchObject({
      targets: [
        {
          key: "studio-123",
          label: "Dungeon",
          detail: "Place 987654",
          placeId: "987654",
        },
        {
          key: "studio-local",
          label: "Local File",
          detail: "Local place",
          placeId: null,
        },
      ],
      selectedKey: null,
    });
    expect(selection.value).toMatchObject({
      selected: { key: "studio-123", placeId: "987654" },
      verified: true,
    });
    expect(localSelection.value).toMatchObject({
      selected: { key: "studio-local", detail: "Local place", placeId: null },
      verified: true,
    });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenNthCalledWith(1, "list_roblox_studios", {});
    expect(callTool).toHaveBeenNthCalledWith(2, "list_roblox_studios", {});
    expect(callTool).toHaveBeenNthCalledWith(3, "list_roblox_studios", {});
  });
});
