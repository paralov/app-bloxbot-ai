import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getUploadAccess,
  MAX_MODEL_BYTES,
  modelDisplayName,
  modelFolder,
  moderationOf,
  openCloudFailure,
  openCloudResponse,
  readModelFile,
  readSentModel,
  recordSentModel,
  sendModelToPlace,
} from "../../electron/services/ModelUpload";
import type { CallStudioTool } from "../../electron/studioQueries";

const STUDIO = "studio-1";
const text = (value: unknown) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
});
const error = (message: string) => ({ ...text(message), isError: true });
const NOT_GRANTED =
  "Could not acquire an Open Cloud access token: Scope 'asset:read' has not been granted. Ask the creator to grant the required scope in the Assistant MCP Permissions settings, then retry.";

interface ToolArgs {
  method?: string;
  endpoint?: string;
  body?: string;
  [key: string]: unknown;
}
type Handler = (args: ToolArgs) => unknown;

function studio(
  handlers: { invoke?: Handler; luau?: Handler; insert?: Handler; list?: Handler } = {},
) {
  const calls: { name: string; args: ToolArgs }[] = [];
  const callTool = (async (name: string, args: ToolArgs) => {
    calls.push({ name, args });
    if (name === "list_roblox_studios") {
      return text(
        handlers.list?.(args) ?? { studios: [{ id: STUDIO, name: "Game (placeId: 123)" }] },
      );
    }
    if (name === "open_cloud_invoke") {
      return (
        handlers.invoke?.(args) ??
        text({
          done: true,
          response: { assetId: "555", moderationResult: { moderationState: "Approved" } },
        })
      );
    }
    if (name === "insert_asset") {
      return (
        handlers.insert?.(args) ??
        text({ insertedInstances: [{ fullPath: "game.Workspace.Crate" }] })
      );
    }
    return (
      handlers.luau?.(args) ??
      text({ placeId: 123, creatorId: 9, creatorType: "Enum.CreatorType.User" })
    );
  }) as unknown as CallStudioTool;
  const uploads = () =>
    calls.filter((c) => c.name === "open_cloud_invoke" && c.args.method === "POST");
  return { callTool, calls, uploads };
}

let dir: string;
let modelUrl: string;
let sentFile: string;
const hash = createHash("sha256").update("model bytes").digest("hex");

const deps = (callTool: CallStudioTool, extra = {}) => ({
  callTool,
  studioId: STUDIO,
  sentFile,
  expectedHash: hash,
  sleep: async () => {},
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-upload-"));
  await writeFile(join(dir, "Crate.fbx"), "model bytes");
  modelUrl = pathToFileURL(join(dir, "Crate.fbx")).href;
  sentFile = join(dir, "sent.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("what this place can do", () => {
  const access = (callTool: CallStudioTool, key: string | null = STUDIO) =>
    getUploadAccess(callTool, key, dir);
  const off = (scope: string) =>
    error(
      `Could not acquire an Open Cloud access token: Scope '${scope}' has not been granted. Ask the creator to grant the required scope in the Assistant MCP Permissions settings, then retry.`,
    );
  const scopeGate = (offScopes: string[], folderApproved = true) => ({
    invoke: (args: ToolArgs) => {
      const missing = (args.scopes as string[]).find((scope) => offScopes.includes(scope));
      if (missing) return off(missing);
      if (args.files && !folderApproved) return error("File not in an approved upload directory");
      return text({ status: 404, body: "{}" });
    },
  });

  it("is ready when everything's on, and runs no script", async () => {
    const { callTool, calls, uploads } = studio(scopeGate([]));
    expect(await access(callTool)).toEqual({ state: "ready", readOn: true, writeOn: true });
    expect(calls.some((c) => c.name === "execute_luau")).toBe(false);
    // Only the folder check posts, to an address that can't create anything.
    expect(uploads().map((c) => c.args.endpoint)).toEqual(["/assets/v1/bloxbot-folder-check"]);
  });

  it("tells each permission apart, since Studio stops at the first one that's off", async () => {
    expect(await access(studio(scopeGate(["asset:read", "asset:write"])).callTool)).toEqual({
      state: "needs_permission",
      readOn: false,
      writeOn: false,
    });
    expect(await access(studio(scopeGate(["asset:read"])).callTool)).toEqual({
      state: "needs_permission",
      readOn: false,
      writeOn: true,
    });
    expect(await access(studio(scopeGate(["asset:write"])).callTool)).toEqual({
      state: "needs_permission",
      readOn: true,
      writeOn: false,
    });
  });

  it("doesn't check the folder until the scopes are on", async () => {
    const { callTool, uploads } = studio(scopeGate(["asset:write"]));
    await access(callTool);
    expect(uploads()).toEqual([]);
  });

  it("finds an unapproved folder, and cleans up its check file", async () => {
    const { callTool, uploads } = studio(scopeGate([], false));
    expect(await access(callTool)).toEqual({
      state: "needs_folder",
      readOn: true,
      writeOn: true,
    });
    const path = String((uploads()[0]?.args.files as { path: string }[])[0]?.path);
    expect(dirname(path)).toBe(dir);
    expect(path).toMatch(/\.glb$/);
    expect(await readdir(dir)).toEqual(["Crate.fbx"]);
  });

  it("says yes when it can't write the check file, and leaves it to the upload", async () => {
    const { callTool } = studio(scopeGate([], false));
    expect((await getUploadAccess(callTool, STUDIO, join(dir, "missing"))).state).toBe("ready");
  });

  it("asks to reopen a Studio from before Roblox's update, as it really answers", async () => {
    const { callTool } = studio({
      invoke: () => error("Tool handler not found: open_cloud_invoke"),
    });
    expect((await access(callTool)).state).toBe("reopen_studio");
  });

  it("knows a local place can't have permissions, without asking Open Cloud", async () => {
    const { callTool, calls } = studio({
      list: () => ({ studios: [{ id: STUDIO, name: "BloxBotScratch.rbxlx" }] }),
    });
    expect((await access(callTool)).state).toBe("not_published");
    expect(calls.some((c) => c.name === "open_cloud_invoke")).toBe(false);
  });

  it("finds the only open Studio for Settings, and won't guess between several", async () => {
    expect((await access(studio().callTool, null)).state).toBe("ready");
    const several = studio({
      list: () => ({
        studios: [
          { id: "a", name: "One (placeId: 1)" },
          { id: "b", name: "Two (placeId: 2)" },
        ],
      }),
    });
    expect((await access(several.callTool, null)).state).toBe("no_studio");
    expect((await access(studio().callTool, "gone")).state).toBe("no_studio");
  });

  it("says no Studio when Studio can't be reached", async () => {
    const callTool = (async () => {
      throw new Error("not connected");
    }) as unknown as CallStudioTool;
    expect((await access(callTool)).state).toBe("no_studio");
  });

  it("finds a linked model's folder without reading it, and only for a model", () => {
    expect(modelFolder(modelUrl)).toBe(dir);
    expect(modelFolder(pathToFileURL(join(dir, "notes.txt")).href)).toBeNull();
    expect(modelFolder("https://example.com/Crate.fbx")).toBeNull();
    expect(modelFolder("file://attacker.example/share/Crate.fbx")).toBeNull();
  });
});

describe("reading Open Cloud's answers", () => {
  it("recognizes each failure Studio's docs list", () => {
    expect(openCloudFailure(NOT_GRANTED)).toBe("needs_permission");
    expect(openCloudFailure("File not in an approved upload directory")).toBe("needs_folder");
    expect(openCloudFailure("Tool handler not found: open_cloud_invoke")).toBe("reopen_studio");
    expect(openCloudFailure("HTTP 403 Forbidden")).toBe("refused");
    expect(openCloudFailure("HTTP 401")).toBe("token_rejected");
    expect(openCloudFailure("HTTP 429")).toBe("rate_limited");
    expect(openCloudFailure("HTTP 400 bad")).toBe("file_rejected");
    expect(openCloudFailure("something else")).toBe("studio_error");
  });

  it("takes a status with a body, or the body alone", () => {
    expect(openCloudResponse(text({ status: 200, body: '{"done":true}' }))).toEqual({
      status: 200,
      body: { done: true },
    });
    expect(openCloudResponse(text({ statusCode: 403, body: {} })).status).toBe(403);
    expect(openCloudResponse(text({ done: true }))).toEqual({ status: 200, body: { done: true } });
    expect(openCloudResponse(text('Status: 404\nBody: {"a":1}')).status).toBe(404);
  });

  it("understands what Roblox really answers and what its docs say", () => {
    const of = (moderationState: string) => moderationOf({ moderationResult: { moderationState } });
    expect(of("Approved")).toBe("approved");
    expect(of("MODERATION_STATE_APPROVED")).toBe("approved");
    expect(of("Rejected")).toBe("rejected");
    expect(of("Reviewing")).toBe("checking");
    expect(moderationOf({})).toBe("checking");
  });
});

describe("reading a model", () => {
  it("reads only local model files within Roblox's limit", async () => {
    expect(await readModelFile(modelUrl)).toMatchObject({
      name: "Crate",
      kind: "fbx",
      folder: dirname(join(dir, "Crate.fbx")),
      hash,
    });
    await writeFile(join(dir, "notes.txt"), "private");
    expect(await readModelFile(pathToFileURL(join(dir, "notes.txt")).href)).toBeNull();
    expect(await readModelFile("https://example.com/Crate.fbx")).toBeNull();
    expect(await readModelFile("file://attacker.example/share/Crate.fbx")).toBeNull();
    expect(await readModelFile(pathToFileURL(join(dir, "missing.fbx")).href)).toBeNull();
    await writeFile(join(dir, "Huge.glb"), Buffer.alloc(MAX_MODEL_BYTES + 1));
    expect(await readModelFile(pathToFileURL(join(dir, "Huge.glb")).href)).toBeNull();
  });

  it("makes a name Roblox will take from a file name", () => {
    expect(modelDisplayName("/a/My_Crate (v2)!.fbx")).toBe("My_Crate v2");
    expect(modelDisplayName("/a/!!!.fbx")).toBe("Model");
    expect(modelDisplayName(`/a/${"x".repeat(80)}.fbx`)).toHaveLength(50);
  });
});

describe("from the click to the place", () => {
  it("uploads the way Roblox's skill says, then adds it", async () => {
    const { callTool, uploads, calls } = studio();
    const steps: string[] = [];
    expect(
      await sendModelToPlace(modelUrl, deps(callTool, { onStep: (s: string) => steps.push(s) })),
    ).toEqual({ status: "added", assetId: "555", path: "game.Workspace.Crate" });
    expect(steps).toEqual(["uploading", "checking", "adding"]);
    const [upload] = uploads();
    expect(upload?.args).toMatchObject({
      studio_id: STUDIO,
      endpoint: "/assets/v1/assets",
      files: [{ name: "fileContent", path: join(dir, "Crate.fbx") }],
      scopes: ["asset:read", "asset:write"],
    });
    expect(JSON.parse(upload?.args.body ?? "{}")).toMatchObject({
      request: {
        assetType: "Model",
        displayName: "Crate",
        creationContext: { creator: { userId: "9" } },
      },
    });
    expect(calls.find((c) => c.name === "insert_asset")?.args).toMatchObject({
      studio_id: STUDIO,
      assetId: "555",
    });
  });

  it("puts the asset on the group when a group owns the game", async () => {
    const { callTool, uploads } = studio({
      luau: () => text({ placeId: 1, creatorId: 77, creatorType: "Enum.CreatorType.Group" }),
    });
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(JSON.parse(uploads()[0]?.args.body ?? "{}").request.creationContext.creator).toEqual({
      groupId: "77",
    });
  });

  it("sends nothing if the file changed after the preview", async () => {
    const { callTool, calls } = studio();
    await writeFile(new URL(modelUrl), "different bytes");
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "failed",
      reason: "file_changed",
    });
    expect(calls).toEqual([]);
  });

  it("sends nothing from a place that isn't published", async () => {
    const { callTool, uploads } = studio({
      luau: () => text({ placeId: 0, creatorId: 0, creatorType: "Enum.CreatorType.User" }),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "needs_setup",
      access: "not_published",
    });
    expect(uploads()).toEqual([]);
  });

  it("says which permission step is missing", async () => {
    const off = studio({ invoke: () => error(NOT_GRANTED) });
    expect(await sendModelToPlace(modelUrl, deps(off.callTool))).toEqual({
      status: "needs_setup",
      access: "needs_permission",
    });
    const old = studio({ invoke: () => error("Tool handler not found: open_cloud_invoke") });
    expect(await sendModelToPlace(modelUrl, deps(old.callTool))).toEqual({
      status: "needs_setup",
      access: "reopen_studio",
    });
  });

  it("names the folder to approve, and records nothing since nothing went up", async () => {
    const { callTool } = studio({
      invoke: () => error("File not in an approved upload directory"),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "needs_folder",
      folder: dir,
    });
    expect(await readSentModel(sentFile, hash)).toBeNull();
  });

  it("never sends the same file twice, and adds it again without uploading", async () => {
    const { callTool, uploads } = studio();
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({
      status: "added",
      assetId: "555",
    });
    expect(uploads()).toHaveLength(1);
  });

  it("never resends a rejected file, and doesn't add it", async () => {
    const { callTool, uploads, calls } = studio({
      invoke: () =>
        text({
          done: true,
          response: { assetId: "9", moderationResult: { moderationState: "Rejected" } },
        }),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "rejected",
      assetId: "9",
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "rejected",
      assetId: "9",
    });
    expect(uploads()).toHaveLength(1);
    expect(calls.some((c) => c.name === "insert_asset")).toBe(false);
  });

  it("keeps a model out of the place until Roblox approves it, without uploading again", async () => {
    let approved = false;
    const { callTool, uploads, calls } = studio({
      invoke: (args) =>
        args.method === "POST"
          ? text({
              done: true,
              response: { assetId: "7", moderationResult: { moderationState: "Reviewing" } },
            })
          : text({ moderationResult: { moderationState: approved ? "Approved" : "Reviewing" } }),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "checking",
      assetId: "7",
    });
    expect(calls.some((c) => c.name === "insert_asset")).toBe(false);
    approved = true;
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({
      status: "added",
      assetId: "7",
    });
    expect(uploads()).toHaveLength(1);
  });

  it("resumes instead of sending again when a check fails after Roblox took the file", async () => {
    let online = false;
    const { callTool, uploads } = studio({
      invoke: (args) => {
        if (args.method === "POST") return text({ path: "operations/abc", done: false });
        expect(args.endpoint).toBe("/assets/v1/operations/abc");
        return online
          ? text({
              done: true,
              response: { assetId: "8", moderationResult: { moderationState: "Approved" } },
            })
          : error("HTTP 503");
      },
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "failed",
      reason: "studio_error",
    });
    online = true;
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({
      status: "added",
      assetId: "8",
    });
    expect(uploads()).toHaveLength(1);
  });

  it("tries once more when a token's refused, as Roblox advises, then stops", async () => {
    let tries = 0;
    const { callTool } = studio({
      invoke: () => {
        tries += 1;
        return tries === 1
          ? error("HTTP 401")
          : text({
              done: true,
              response: { assetId: "1", moderationResult: { moderationState: "Approved" } },
            });
      },
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({ status: "added" });

    const always = studio({ invoke: () => error("HTTP 401") });
    await rm(sentFile, { force: true });
    expect(await sendModelToPlace(modelUrl, deps(always.callTool))).toEqual({
      status: "failed",
      reason: "refused",
    });
    expect(always.uploads()).toHaveLength(2);
  });

  it("explains a refusal, a refused file and a busy Roblox", async () => {
    for (const [message, reason] of [
      ["HTTP 403", "refused"],
      ["HTTP 429", "rate_limited"],
      ["HTTP 400", "file_rejected"],
      ["HTTP 500", "studio_error"],
    ] as const) {
      const { callTool } = studio({ invoke: () => error(message) });
      expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
        status: "failed",
        reason,
      });
    }
  });

  it("says when Roblox took it but Studio couldn't add it, and only adds next time", async () => {
    const { callTool, uploads } = studio({ insert: () => error("Studio closed") });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "not_added",
      assetId: "555",
    });
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(uploads()).toHaveLength(1);
  });

  it("does nothing without a file", async () => {
    const { callTool, calls } = studio();
    expect(await sendModelToPlace("file:///nope/Gone.fbx", deps(callTool))).toEqual({
      status: "failed",
      reason: "no_file",
    });
    expect(calls).toEqual([]);
  });

  it("holds no key anywhere", async () => {
    const { callTool, calls } = studio();
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(JSON.stringify(calls)).not.toMatch(/api.?key|x-api/i);
    expect(await readFile(sentFile, "utf8")).not.toMatch(/key/i);
  });

  it("keeps every record when uploads finish together", async () => {
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) =>
        recordSentModel(sentFile, id, { assetId: id, moderation: "approved" }),
      ),
    );
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect((await readSentModel(sentFile, id))?.assetId).toBe(id);
    }
  });
});
