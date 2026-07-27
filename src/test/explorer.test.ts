import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createExplorerReference,
  ExplorerProgramEnvelopeSchema,
  ExplorerSnapshotSchema,
  generateExplorerProgram,
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

  it("generates a reusable TypeScript program in a disposable private session", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "hidden-session" } });
    const structured = {
      version: 1,
      contract: {
        name: "explorer-snapshot",
        version: "1",
        inputSchemaVersion: "explorer-input-v1",
        outputSchemaVersion: "explorer-snapshot-v1",
      },
      source: "async function run({ callTool }) { return callTool('inspect_place', {}); }",
    };
    const prompt = vi.fn().mockResolvedValue({ data: { info: { structured } } });
    const remove = vi.fn().mockResolvedValue({ data: true });
    const client = { session: { create, prompt, delete: remove } };

    await expect(
      generateExplorerProgram(
        client as never,
        { providerID: "anthropic", modelID: "claude" },
        "build",
      ),
    ).resolves.toEqual(structured);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { bloxbotHidden: true, purpose: "explorer" } }),
      { throwOnError: true },
    );
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
