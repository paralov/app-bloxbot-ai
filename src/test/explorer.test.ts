import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createExplorerReference,
  ExplorerCollectionSchema,
  ExplorerSnapshotSchema,
  generateExplorerCollection,
  replayExplorerCollector,
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

  it("generates a collector and initial snapshot in a disposable private session", async () => {
    const create = vi.fn().mockResolvedValue({ data: { id: "hidden-session" } });
    const structured = { collector: "READ_ONLY_COLLECTOR", snapshot };
    const prompt = vi.fn().mockResolvedValue({ data: { info: { structured } } });
    const remove = vi.fn().mockResolvedValue({ data: true });
    const client = { session: { create, prompt, delete: remove } };

    await expect(
      generateExplorerCollection(
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
  });

  it("replays the retained collector verbatim without asking for a new plan", async () => {
    const prompt = vi.fn().mockResolvedValue({ data: { info: { structured: snapshot } } });
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: "replay-session" } }),
        prompt,
        delete: vi.fn().mockResolvedValue({ data: true }),
      },
    };

    await expect(replayExplorerCollector(client as never, "EXACT COLLECTOR")).resolves.toEqual(
      snapshot,
    );
    const request = prompt.mock.calls[0][0];
    expect(request.parts[0].text).toContain("<collector>\nEXACT COLLECTOR\n</collector>");
    expect(request.parts[0].text).not.toContain("design");
    expect(request.format).toMatchObject({ type: "json_schema", retryCount: 1 });
  });

  it("rejects invalid collectors before they can be retained", async () => {
    await expect(
      Effect.runPromise(
        Schema.decodeUnknown(ExplorerCollectionSchema)({ collector: "", snapshot }),
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
