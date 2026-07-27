import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_EXPLORER_PROGRAM } from "@/lib/builtinStudioPrograms";
import { ExplorerSnapshotSchema } from "@/lib/explorer";
import {
  GeneratedProgramRuntimeError,
  startGeneratedProgramRuntime,
} from "../../electron/services/GeneratedProgramRuntime";

const envelope = (source: string) => ({
  version: 1 as const,
  contract: {
    name: "test-program",
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
        const result = await callTool("inspect_place", { depth: input.depth });
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
    expect(callTool).toHaveBeenCalledWith("inspect_place", { depth: 3 });
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
        envelope('async function run({ callTool }) { return callTool("missing", {}); }'),
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
              name: "SpawnLocation",
              className: "SpawnLocation",
            },
          ]),
        },
      ],
    });
    const runtime = startGeneratedProgramRuntime(callTool);
    const artifact = await Effect.runPromise(runtime.compile(BUILTIN_EXPLORER_PROGRAM));
    const result = await Effect.runPromise(runtime.invoke({ artifact, input: null }));
    const snapshot = await Effect.runPromise(
      Schema.decodeUnknown(ExplorerSnapshotSchema)(result.value),
    );

    expect(snapshot.roots).toHaveLength(1);
    expect(snapshot.roots.find((node) => node.name === "Workspace")?.children[0]?.name).toBe(
      "SpawnLocation",
    );
    expect(callTool).toHaveBeenCalledWith("search_game_tree", {
      max_depth: 10,
      head_limit: 100_000,
    });
  });
});
