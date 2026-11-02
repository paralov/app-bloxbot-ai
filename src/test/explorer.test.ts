import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  createExplorerReference,
  ExplorerProgramEnvelopeSchema,
  ExplorerSnapshotSchema,
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
