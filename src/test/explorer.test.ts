import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createExplorerReference,
  ExplorerGenerationError,
  ExplorerProgramEnvelopeSchema,
  ExplorerSnapshotSchema,
  explorerSystemPrompt,
  generateExplorerProgram,
  MAX_EXPLORER_GENERATIONS,
  sortExplorerNodes,
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

  it("validates recursive snapshots owned by the app", async () => {
    await expect(
      Effect.runPromise(Schema.decodeUnknown(ExplorerSnapshotSchema)(snapshot)),
    ).resolves.toEqual(snapshot);

    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(ExplorerSnapshotSchema)({
          ...snapshot,
          roots: [{ ...snapshot.roots[0], hasChildren: "yes" }],
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("matches Studio's class order and sorts names within a class", () => {
    const makeNode = (name: string, className: string) => ({
      name,
      className,
      path: `game.Workspace.${name}`,
      hasChildren: false,
      properties: [],
      attributes: [],
      children: [],
    });

    const sorted = sortExplorerNodes([
      makeNode("Baseplate", "Part"),
      makeNode("Zebra", "Script"),
      makeNode("LocalScript", "LocalScript"),
      makeNode("Terrain", "Terrain"),
      makeNode("Alpha", "Script"),
      makeNode("Camera", "Camera"),
      makeNode("ModuleScript", "ModuleScript"),
      makeNode("SpawnLocation", "SpawnLocation"),
    ]);

    expect(sorted.map((node) => node.name)).toEqual([
      "Camera",
      "Terrain",
      "Alpha",
      "Zebra",
      "SpawnLocation",
      "LocalScript",
      "ModuleScript",
      "Baseplate",
    ]);
  });

  const structured = {
    version: 1,
    contract: {
      name: "explorer-snapshot",
      version: "1",
      inputSchemaVersion: "explorer-input-v1",
      outputSchemaVersion: "explorer-snapshot-v1",
    },
    source: "async function run({ callTool }) { return callTool('search_game_tree', {}); }",
  };
  const allowedTools = ["list_roblox_studios", "search_game_tree", "inspect_instance"];

  function fakeClient(...responses: unknown[]) {
    const create = vi.fn().mockResolvedValue({ data: { id: "hidden-session" } });
    const prompt = vi.fn();
    for (const response of responses) {
      prompt.mockResolvedValueOnce({ data: { info: { structured: response } } });
    }
    const remove = vi.fn().mockResolvedValue({ data: true });
    return { client: { session: { create, prompt, delete: remove } }, create, prompt, remove };
  }

  it("generates a reusable TypeScript program in a disposable private session", async () => {
    const { client, create, prompt, remove } = fakeClient(structured);
    const validate = vi.fn().mockResolvedValue("snapshot");

    await expect(
      generateExplorerProgram(client as never, {
        model: { providerID: "anthropic", modelID: "claude" },
        agent: "build",
        allowedTools,
        validate,
      }),
    ).resolves.toEqual({ program: structured, result: "snapshot", attempts: 1 });

    expect(validate).toHaveBeenCalledWith(structured);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { bloxbotHidden: true, purpose: "explorer" } }),
      { throwOnError: true },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "hidden-session",
        format: expect.objectContaining({ type: "json_schema", retryCount: 2 }),
      }),
      { throwOnError: true },
    );
    expect(remove).toHaveBeenCalledWith({ sessionID: "hidden-session" }, { throwOnError: true });
    expect(prompt.mock.calls[0][0].system).toContain("compile this source once");
    expect(prompt.mock.calls[0][0].system).toContain("callTool");
  });

  it("names exactly the tools the runtime allows in the generation prompt", () => {
    const prompt = explorerSystemPrompt(allowedTools);
    expect(prompt).toContain(
      "may only call these tools, by exactly these names: list_roblox_studios, search_game_tree, inspect_instance.",
    );
    expect(prompt).toContain("The runtime refuses any other tool.");
    expect(prompt).toContain('"roblox-studio_" prefix');
    // The snapshot the program must return, so its output validates.
    expect(prompt).toContain('"required":["placeName","capturedAt","roots"]');
  });

  it("sends a failed check back to the model once in the same session", async () => {
    const fixed = { ...structured, source: `${structured.source}\n// fixed` };
    const { client, create, prompt, remove } = fakeClient(structured, fixed);
    const validate = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Generated program tool contract failed: explorer-snapshot programs may not call get_place",
        ),
      )
      .mockResolvedValueOnce("snapshot");

    await expect(
      generateExplorerProgram(client as never, { allowedTools, validate }),
    ).resolves.toEqual({ program: fixed, result: "snapshot", attempts: 2 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(prompt.mock.calls[1][0].sessionID).toBe("hidden-session");
    const retry = prompt.mock.calls[1][0].parts[0].text as string;
    expect(retry).toContain("may not call get_place");
    expect(retry).toContain("list_roblox_studios, search_game_tree, inspect_instance");
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("retries output that doesn't match the program envelope", async () => {
    const { client, prompt } = fakeClient({ source: "no contract" }, structured);
    const validate = vi.fn().mockResolvedValue("snapshot");

    await expect(
      generateExplorerProgram(client as never, { allowedTools, validate }),
    ).resolves.toMatchObject({ attempts: 2 });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("gives up after two programs and reports how many were written", async () => {
    const { client, prompt, remove } = fakeClient(structured, structured, structured);
    const validate = vi.fn().mockRejectedValue(new Error("Generated program did not compile"));

    const failure = await generateExplorerProgram(client as never, {
      allowedTools,
      validate,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExplorerGenerationError);
    expect(failure).toMatchObject({
      attempts: MAX_EXPLORER_GENERATIONS,
      message: "Generated program did not compile",
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid generated program contracts", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(ExplorerProgramEnvelopeSchema)({
          version: 1,
          contract: {
            name: "wrong-contract",
            version: "1",
            inputSchemaVersion: "explorer-input-v1",
            outputSchemaVersion: "explorer-snapshot-v1",
          },
          source: "async function run() {}",
        }),
      ),
    ).rejects.toBeDefined();
  });

  it("makes paths non-authoritative when inserting an object into chat", () => {
    const prompt = createExplorerReference(snapshot.roots[0].children[0]);
    expect(prompt).toContain("game.Workspace.SpawnLocation");
    expect(prompt).toContain("only as a hint");
    expect(prompt).toContain("Rediscover");
    expect(prompt).toContain("verify its identity and current state immediately");
  });
});
