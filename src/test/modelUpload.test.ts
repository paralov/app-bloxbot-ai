import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { networkDriveLetters } from "../../electron/networkDrives";
import {
  getUploadAccess,
  isNetworkPath,
  localTarget,
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

/** Windows only makes links with Developer Mode or as an administrator. */
const canLink = (() => {
  const probe = mkdtempSync(join(tmpdir(), "model-link-"));
  try {
    symlinkSync(join(probe, "target"), join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
/** Root can write anywhere, so a read-only folder only stops everyone else. */
const canLockFolder = process.platform !== "win32" && process.getuid?.() !== 0;
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
  handlers: {
    invoke?: Handler;
    luau?: Handler;
    insert?: Handler;
    list?: Handler;
    lookup?: Handler;
  } = {},
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
    // A place with nothing an earlier insert left behind.
    if (String(args.code).includes("PackageId")) return handlers.lookup?.(args) ?? text("none");
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

// Reading a model asks Windows for its mapped drives through PowerShell, whose first start on a CI
// runner can outlast a test's 5 seconds. The answer is kept for 30 seconds, so ask once up front.
beforeAll(() => networkDriveLetters(), 30_000);

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
      if (args.files && !folderApproved) {
        return error("/tmp/check.glb is not inside a directory approved for uploads.");
      }
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

  it("isn't ready when it can't write the check file, since the upload's copy can't go there either", async () => {
    const { callTool, uploads } = studio(scopeGate([]));
    expect((await getUploadAccess(callTool, STUDIO, join(dir, "missing"))).state).toBe(
      "folder_unwritable",
    );
    expect(uploads()).toEqual([]);
  });

  it("asks to reopen a Studio from before Roblox's update, as it really answers", async () => {
    const { callTool } = studio({
      invoke: () => error("Tool handler not found: open_cloud_invoke"),
    });
    expect((await access(callTool)).state).toBe("reopen_studio");
  });

  it("checks a published place even when Studio hasn't sent its name", async () => {
    const { callTool } = studio({
      ...scopeGate([]),
      list: () => ({ studios: [{ id: STUDIO, name: null, place_id: 123 }] }),
    });
    expect((await access(callTool)).state).toBe("ready");
  });

  it("says when Studio can't get a sign-in Roblox accepts, instead of ready", async () => {
    const { callTool } = studio({
      invoke: () => error("GET https://apis.roblox.com/x -> 401 Unauthorized"),
    });
    expect((await access(callTool)).state).toBe("refused");
  });

  it("doesn't call a place unpublished while it's still loading and has no name", async () => {
    const { callTool } = studio({ list: () => ({ studios: [{ id: STUDIO, name: null }] }) });
    expect((await access(callTool)).state).toBe("no_studio");
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
    expect((await access(several.callTool, null)).state).toBe("choose_studio");
    expect((await access(studio().callTool, "gone")).state).toBe("no_studio");
  });

  it("doesn't call a check Roblox throttled ready, so it asks again", async () => {
    const throttled = studio({
      invoke: () => error("GET https://apis.roblox.com/x -> 429 Too Many"),
    });
    expect((await access(throttled.callTool)).state).toBe("rate_limited");
    const folderThrottled = studio({
      invoke: (args) => (args.files ? error("HTTP 429") : text({ status: 404, body: "{}" })),
    });
    expect((await access(folderThrottled.callTool)).state).toBe("rate_limited");
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
  it("reads Roblox's real answers, copied from a live Studio", () => {
    const ok = {
      ...text(
        'GET https://apis.roblox.com/assets/v1/assets/93335532265442 -> 200 OK\n\n{"assetId":"93335532265442","moderationResult":{"moderationState":"Approved"}}',
      ),
      isError: false,
    };
    const answer = openCloudResponse(ok);
    expect(answer.status).toBe(200);
    expect(answer.body.assetId).toBe("93335532265442");
    expect(moderationOf(answer.body)).toBe("approved");

    expect(
      openCloudFailure(
        'GET https://apis.roblox.com/assets/v1/assets/1 -> 404 Not Found\n\n{\n  "code": "NOT_FOUND"\n}',
      ),
    ).toBe("file_rejected");
    expect(
      openCloudFailure(
        "/var/folders/T/check.glb is not inside a directory approved for uploads. Ask the creator to add the file's directory to the approved upload directories in Assistant Settings -> MCP Permissions, then retry. Do not copy or move the file to work around this.",
      ),
    ).toBe("needs_folder");
  });

  it("isn't fooled by a number in a URL", () => {
    expect(
      openCloudFailure("GET https://apis.roblox.com/assets/v1/assets/403 -> 429 Too Many"),
    ).toBe("rate_limited");
    expect(
      openCloudResponse(
        text('GET https://apis.roblox.com/assets/v1/assets/500 -> 200 OK\n\n{"a":1}'),
      ),
    ).toEqual({ status: 200, body: { a: 1 } });
  });

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

  it("knows a network share however Windows spells it", () => {
    for (const share of [
      "\\\\server\\share\\Crate.fbx",
      "//server/share/Crate.fbx",
      "\\\\?\\UNC\\server\\share\\Crate.fbx",
    ]) {
      expect(isNetworkPath(share)).toBe(true);
    }
    for (const local of [
      "C:\\Users\\me\\Crate.fbx",
      "/Users/me/Crate.fbx",
      "\\\\?\\C:\\Models\\Crate.fbx",
      "\\\\.\\C:\\Models\\Crate.fbx",
    ]) {
      expect(isNetworkPath(local)).toBe(false);
    }
  });

  it("won't read from a drive letter Windows maps to a network share", async () => {
    const mapped = async () => new Set(["Z"]);
    expect(await localTarget("Z:\\Models\\Crate.fbx", mapped)).toBeNull();
    expect(await localTarget("z:/Models/Crate.fbx", mapped)).toBeNull();
  });

  it.runIf(canLink)("reads a model through a link to a file on this computer", async () => {
    await mkdir(join(dir, "real"));
    await writeFile(join(dir, "real", "Crate.fbx"), "model bytes");
    await symlink(join(dir, "real", "Crate.fbx"), join(dir, "Linked.fbx"));
    expect(await readModelFile(pathToFileURL(join(dir, "Linked.fbx")).href)).toMatchObject({
      name: "Linked",
      hash,
    });
  });

  // Elsewhere "//" is just the root, so these links reach a real file unless they're refused first.
  it.runIf(canLink && process.platform !== "win32")(
    "won't follow a link to a network share, to the file or its folder",
    async () => {
      const real = join(dir, "real");
      await mkdir(real);
      await writeFile(join(real, "Crate.fbx"), "model bytes");
      await symlink(`/${join(real, "Crate.fbx")}`, join(dir, "Share.fbx"));
      await symlink(`/${real}`, join(dir, "share"));
      expect(await readModelFile(pathToFileURL(join(dir, "Share.fbx")).href)).toBeNull();
      expect(await readModelFile(pathToFileURL(join(dir, "share", "Crate.fbx")).href)).toBeNull();
    },
  );

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
      files: [{ name: "fileContent", path: expect.stringMatching(/\.bloxbot-upload-.+\.fbx$/) }],
      scopes: ["asset:read", "asset:write"],
    });
    // A copy in the model's own folder, which is the one Studio approved.
    expect(dirname(String((upload?.args.files as { path: string }[])[0]?.path))).toBe(dir);
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

  it("sends the bytes that were checked, even if the file changes before Studio reads it", async () => {
    let sentBytes = "";
    const { callTool, uploads } = studio({
      // Another export lands while the owner is read, after the check.
      luau: async () => {
        await writeFile(join(dir, "Crate.fbx"), "replaced bytes");
        return text({ placeId: 123, creatorId: 9, creatorType: "Enum.CreatorType.User" });
      },
      invoke: (args) => {
        if (args.method === "POST") {
          const [sent] = args.files as { path: string }[];
          return readFile(String(sent?.path), "utf8").then((bytes) => {
            sentBytes = bytes;
            return text({
              done: true,
              response: { assetId: "555", moderationResult: { moderationState: "Approved" } },
            });
          });
        }
        return undefined;
      },
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({ status: "added" });
    expect(uploads()).toHaveLength(1);
    expect(sentBytes).toBe("model bytes");
    // The copy goes once Studio has it.
    expect((await readdir(dir)).sort()).toEqual(["Crate.fbx", "sent.json"]);
  });

  it("reads the game's owner during a playtest, when Studio refuses Edit", async () => {
    const { callTool, calls, uploads } = studio({
      luau: (args) =>
        args.datamodel_type === "Edit"
          ? error("Edit data model is not available in Play mode")
          : text({ placeId: 123, creatorId: 9, creatorType: "Enum.CreatorType.User" }),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({ status: "added" });
    expect(uploads()).toHaveLength(1);
    expect(
      calls.filter((c) => c.name === "execute_luau").map((c) => c.args.datamodel_type),
    ).toEqual(expect.arrayContaining(["Edit", "Server"]));
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

  it("says Studio didn't answer when it can't read the game's owner, rather than doing nothing", async () => {
    const { callTool, uploads } = studio({ luau: () => error("Studio is busy") });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "failed",
      reason: "studio_error",
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

  it("keeps a finished upload with no operation, even when the moderation check fails", async () => {
    let online = false;
    const { callTool, uploads } = studio({
      invoke: (args) =>
        args.method === "POST"
          ? text({
              done: true,
              response: { assetId: "6", moderationResult: { moderationState: "Reviewing" } },
            })
          : online
            ? text({ moderationResult: { moderationState: "Approved" } })
            : error("HTTP 503"),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "failed",
      reason: "studio_error",
    });
    expect(await readSentModel(sentFile, hash)).toMatchObject({ assetId: "6" });
    online = true;
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toMatchObject({
      status: "added",
      assetId: "6",
    });
    expect(uploads()).toHaveLength(1);
  });

  it("sends the same bytes once when two links and two Studios ask at the same time", async () => {
    await writeFile(join(dir, "Copy.fbx"), "model bytes");
    const { callTool, uploads, calls } = studio({
      list: () => ({
        studios: [
          { id: STUDIO, name: "Game (placeId: 123)" },
          { id: "studio-2", name: "Other (placeId: 456)" },
        ],
      }),
    });
    const results = await Promise.all([
      sendModelToPlace(modelUrl, deps(callTool)),
      sendModelToPlace(
        pathToFileURL(join(dir, "Copy.fbx")).href,
        deps(callTool, { studioId: "studio-2" }),
      ),
    ]);
    expect(results.map((result) => result.status)).toEqual(["added", "added"]);
    expect(uploads()).toHaveLength(1);
    // Each Studio still gets the model in its own place.
    expect(calls.filter((c) => c.name === "insert_asset").map((c) => c.args.studio_id)).toEqual(
      expect.arrayContaining([STUDIO, "studio-2"]),
    );
  });

  it.runIf(canLockFolder)(
    "says the folder can't take the upload's copy, and sends nothing",
    async () => {
      const { callTool, uploads } = studio();
      await chmod(dir, 0o555);
      try {
        expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
          status: "failed",
          reason: "folder_unwritable",
        });
      } finally {
        await chmod(dir, 0o755);
      }
      expect(uploads()).toEqual([]);
    },
  );

  it("gives each game owner their own asset, and reuses each one's", async () => {
    let owner = { creatorId: 9, creatorType: "Enum.CreatorType.User" };
    let next = 1;
    const { callTool, uploads, calls } = studio({
      luau: () => text({ placeId: 123, ...owner }),
      invoke: () =>
        text({
          done: true,
          response: {
            assetId: String(next++),
            moderationResult: { moderationState: "Approved" },
          },
        }),
    });
    const inserted = () =>
      calls.filter((c) => c.name === "insert_asset").map((c) => c.args.assetId);
    await sendModelToPlace(modelUrl, deps(callTool));
    owner = { creatorId: 77, creatorType: "Enum.CreatorType.Group" };
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(JSON.parse(uploads()[1]?.args.body ?? "{}").request.creationContext.creator).toEqual({
      groupId: "77",
    });
    owner = { creatorId: 9, creatorType: "Enum.CreatorType.User" };
    await sendModelToPlace(modelUrl, deps(callTool));
    expect(uploads()).toHaveLength(2);
    expect(inserted()).toEqual(["1", "2", "1"]);
  });

  it("never uploads from a card that only adds, even for a game with another owner", async () => {
    let owner = { creatorId: 9, creatorType: "Enum.CreatorType.User" };
    const { callTool, uploads, calls } = studio({
      luau: () => text({ placeId: 123, ...owner }),
    });
    await sendModelToPlace(modelUrl, deps(callTool));
    owner = { creatorId: 77, creatorType: "Enum.CreatorType.Group" };

    const result = await sendModelToPlace(modelUrl, { ...deps(callTool), addOnly: true });

    expect(result).toEqual({ status: "failed", reason: "other_owner" });
    expect(uploads()).toHaveLength(1);
    expect(calls.filter((c) => c.name === "insert_asset")).toHaveLength(1);
  });

  it("doesn't add it to another place the same Studio opened while Roblox checked", async () => {
    let place = "Game (placeId: 123)";
    const { callTool, calls } = studio({
      list: () => ({ studios: [{ id: STUDIO, name: place }] }),
      invoke: () => {
        place = "Another game (placeId: 456)";
        return text({
          done: true,
          response: { assetId: "555", moderationResult: { moderationState: "Approved" } },
        });
      },
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "not_added",
      assetId: "555",
      reason: "place_changed",
    });
    expect(calls.some((c) => c.name === "insert_asset")).toBe(false);
  });

  it("won't upload for an owner read after the place changed", async () => {
    let place = "Game (placeId: 123)";
    const { callTool, uploads } = studio({
      list: () => ({ studios: [{ id: STUDIO, name: place }] }),
      luau: () => {
        place = "Another game (placeId: 456)";
        return text({ placeId: 456, creatorId: 77, creatorType: "Enum.CreatorType.Group" });
      },
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "failed",
      reason: "place_changed",
    });
    expect(uploads()).toEqual([]);
  });

  it("checks the place in the same script that looks for an earlier insert", async () => {
    const { callTool, calls } = studio({ lookup: () => text("moved") });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "not_added",
      assetId: "555",
      reason: "place_changed",
    });
    const lookup = calls.find((c) => String(c.args.code).includes("PackageId"));
    expect(String(lookup?.args.code)).toContain("game.PlaceId ~= 123");
    expect(calls.some((c) => c.name === "insert_asset")).toBe(false);
  });

  it("adds an asset once when two cards add it to the same Studio at once", async () => {
    await recordSentModel(sentFile, hash, {
      assetId: "4",
      moderation: "approved",
      owner: "user:9",
    });
    // Studio takes a moment to insert, which is when the second card's add arrives.
    const { callTool, calls } = studio({
      insert: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(text({ insertedInstances: [{ fullPath: "game.Workspace.Crate" }] })),
            50,
          ),
        ) as never,
    });
    const [first, second] = await Promise.all([
      sendModelToPlace(modelUrl, deps(callTool)),
      sendModelToPlace(modelUrl, { ...deps(callTool), addOnly: true }),
    ]);
    expect(first).toEqual(second);
    expect(calls.filter((c) => c.name === "insert_asset")).toHaveLength(1);
  });

  it("says to stop a playtest when that's why it wasn't added", async () => {
    const { callTool, calls } = studio({
      lookup: (args) =>
        args.datamodel_type === "Edit"
          ? error("Edit data model is not available in Play mode")
          : text("none"),
    });
    expect(await sendModelToPlace(modelUrl, deps(callTool))).toEqual({
      status: "not_added",
      assetId: "555",
      reason: "playtest",
    });
    expect(calls.some((c) => c.name === "insert_asset")).toBe(false);
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
