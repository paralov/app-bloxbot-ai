import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ModelUploadFailure,
  ModelUploadResult,
  ModelUploadStep,
  NotAddedReason,
  UploadAccessState,
} from "../../src/types/desktop";
import type { StudioTarget } from "../../src/types/studioTarget";
import { isOpenableUrl } from "../openableUrl";
import {
  type CallStudioTool,
  discoverStudioTargets,
  insertUploadedModel,
  mcpData,
  mcpError,
  PLACE_CHANGED,
  runScript,
  STOP_PLAYTEST,
} from "../studioQueries";

/** Roblox's limit for one file through open_cloud_invoke. */
export const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const MODEL_EXTENSIONS = new Set([".fbx", ".glb"]);
const MAX_NAME_LENGTH = 50;
const UPLOAD_SCOPES = ["asset:read", "asset:write"];
const OPERATION_POLL_MS = 3_000;
const OPERATION_POLLS = 20;
// Roblox's import skill: every 10 to 20 seconds for a few minutes, and never upload again to get past it.
const MODERATION_POLL_MS = 10_000;
const MODERATION_POLLS = 18;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type OpenCloudFailure =
  | ModelUploadFailure
  | Extract<UploadAccessState, "reopen_studio" | "needs_permission">
  | "needs_folder"
  | "token_rejected";

class OpenCloudError extends Error {
  constructor(readonly reason: OpenCloudFailure) {
    super(reason);
    this.name = "OpenCloudError";
  }
}

// ── Open Cloud, through Studio ──────────────────────────────────────────

const failureFromStatus = (status: number): OpenCloudFailure => {
  if (status === 401) return "token_rejected";
  if (status === 403) return "refused";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "studio_error" : "file_rejected";
};

/** Studio words these for people, and these are the phrases its docs and skills promise. */
export function openCloudFailure(text: string): OpenCloudFailure {
  if (/Tool handler not found|unknown tool/i.test(text)) return "reopen_studio";
  if (/has not been granted/i.test(text)) return "needs_permission";
  if (/approved for uploads|approved upload|upload director/i.test(text)) return "needs_folder";
  // Roblox's answers read "GET https://... -> 404 Not Found", and a URL can have any number in it.
  const status = /->\s*(\d{3})\b/.exec(text)?.[1] ?? /\b([45]\d\d)\b/.exec(text)?.[1];
  return status ? failureFromStatus(Number(status)) : "studio_error";
}

const httpStatus = (value: unknown) => {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status < 600 ? status : null;
};

/** Roblox's answers read "GET https://... -> 200 OK", then the body. This also takes a wrapper, in case that changes. */
export function openCloudResponse(result: Parameters<typeof mcpData>[0]): {
  status: number;
  body: any;
} {
  const data = mcpData(result);
  const text = (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(" ");
  const status =
    httpStatus(data?.status ?? data?.statusCode ?? data?.status_code) ??
    httpStatus(/->\s*(\d{3})\b/.exec(text)?.[1]) ??
    httpStatus(/\b(?:status(?:\s*code)?|HTTP)\D{0,5}(\d{3})\b/i.exec(text)?.[1]) ??
    200;
  let body = data?.body ?? data?.responseBody ?? data?.response_body ?? data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  return { status, body };
}

interface OpenCloudRequest {
  method: "GET" | "POST";
  endpoint: string;
  scopes: string[];
  body?: string;
  files?: { name: string; path: string }[];
}

async function callOpenCloud(
  callTool: CallStudioTool,
  studioId: string,
  request: OpenCloudRequest,
  tokenRetried = false,
): Promise<any> {
  const result = await callTool("open_cloud_invoke", { studio_id: studioId, ...request }).catch(
    (error: unknown) => {
      throw new OpenCloudError(openCloudFailure(error instanceof Error ? error.message : ""));
    },
  );
  const error = mcpError(result);
  const response = error ? null : openCloudResponse(result);
  const failure = error
    ? openCloudFailure(error)
    : response && response.status >= 400
      ? failureFromStatus(response.status)
      : null;
  if (!failure) return response?.body;
  // Each call gets a new token, so Roblox's advice for a refused one is to try once more.
  if (failure === "token_rejected") {
    if (!tokenRetried) return callOpenCloud(callTool, studioId, request, true);
    throw new OpenCloudError("refused");
  }
  throw new OpenCloudError(failure);
}

// ── Can this place upload? ──────────────────────────────────────────────

/** Studio only reports a place's ID in its name. Permissions are per game, so a local place has none. */
const isPublished = (target: StudioTarget) =>
  !!target.placeId || /\(placeId:\s*[1-9]\d*\)\s*$/.test(target.label);

export interface UploadAccessDetails {
  /** "rate_limited" means Roblox didn't answer this time, so the last answer still stands. */
  state: UploadAccessState | "rate_limited";
  readOn: boolean;
  writeOn: boolean;
}

/** Whether Studio will give a token for this scope. It says no before anything is sent. */
async function scopeIsOn(
  callTool: CallStudioTool,
  studioId: string,
  scope: string,
): Promise<boolean> {
  try {
    await callOpenCloud(callTool, studioId, {
      method: "GET",
      endpoint: "/assets/v1/assets/1",
      scopes: [scope],
    });
  } catch (error) {
    if (error instanceof OpenCloudError && error.reason === "needs_permission") return false;
    // Roblox answered about the asset itself, so Studio had a token for the scope.
    if (error instanceof OpenCloudError && error.reason === "file_rejected") return true;
    // Anything else, like being told to slow down, says nothing about the permission.
    throw error;
  }
  return true;
}

/**
 * Roblox has no way to ask which folders are approved, but Studio refuses a file from anywhere else.
 * So this offers a tiny blank file to an address that doesn't exist. Nothing can be created, and the
 * file is deleted again. When it can't tell, it says yes and lets the real upload report the problem.
 * A folder it can't write to can't take the upload's copy either, so that's an answer of its own.
 */
async function folderState(
  callTool: CallStudioTool,
  studioId: string,
  folder: string,
): Promise<"ready" | "needs_folder" | "folder_unwritable"> {
  const probe = join(folder, `.bloxbot-folder-check-${randomUUID()}.glb`);
  try {
    await writeFile(probe, "glTF");
  } catch {
    return "folder_unwritable";
  }
  try {
    await callOpenCloud(callTool, studioId, {
      method: "POST",
      endpoint: "/assets/v1/bloxbot-folder-check",
      body: "{}",
      files: [{ name: "fileContent", path: probe }],
      scopes: ["asset:write"],
    });
    return "ready";
  } catch (error) {
    // Being told to slow down isn't an answer, and the next check can ask again.
    if (error instanceof OpenCloudError && error.reason === "rate_limited") throw error;
    return error instanceof OpenCloudError && error.reason === "needs_folder"
      ? "needs_folder"
      : "ready";
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
}

/**
 * Safe to run in the background. It runs no script, which would clear Studio's redo history, and
 * each scope is asked for alone, because Studio stops at the first one that's off.
 */
export async function getUploadAccess(
  callTool: CallStudioTool,
  studioKey: string | null,
  folder: string,
): Promise<UploadAccessDetails> {
  const none = (state: UploadAccessDetails["state"]): UploadAccessDetails => ({
    state,
    readOn: false,
    writeOn: false,
  });
  let targets: readonly StudioTarget[];
  try {
    targets = (await discoverStudioTargets(callTool)).targets;
  } catch {
    return none("no_studio");
  }
  const target = studioKey
    ? targets.find((candidate) => candidate.key === studioKey)
    : targets.length === 1
      ? targets[0]
      : undefined;
  // Several are open and this chat hasn't picked one, which opening another place wouldn't fix.
  if (!target) return none(!studioKey && targets.length > 1 ? "choose_studio" : "no_studio");
  // A place that's still loading has no name yet, which says nothing about whether it's published.
  if (!target.placeId && target.label === target.key) return none("no_studio");
  if (!isPublished(target)) return none("not_published");
  try {
    const readOn = await scopeIsOn(callTool, target.key, "asset:read");
    const writeOn = await scopeIsOn(callTool, target.key, "asset:write");
    if (!readOn || !writeOn) return { state: "needs_permission", readOn, writeOn };
    return { state: await folderState(callTool, target.key, folder), readOn, writeOn };
  } catch (error) {
    if (
      error instanceof OpenCloudError &&
      (error.reason === "reopen_studio" || error.reason === "rate_limited")
    ) {
      return none(error.reason);
    }
    return none(error instanceof OpenCloudError && error.reason === "refused" ? "refused" : "no_studio");
  }
}

/**
 * Who a new asset belongs to, which Roblox says must be the game's owner. Only runs after a click.
 * "unpublished" is a real answer, and null means Studio couldn't say.
 */
async function readGameOwner(
  callTool: CallStudioTool,
  studioId: string,
): Promise<{ userId: string } | { groupId: string } | "unpublished" | null> {
  // The game's owner is the same in a playtest, so this can be read there too.
  const result = await runScript(
    callTool,
    studioId,
    `return game:GetService("HttpService"):JSONEncode({ placeId = game.PlaceId, creatorId = game.CreatorId, creatorType = tostring(game.CreatorType) })`,
  );
  if (mcpError(result)) return null;
  const data = mcpData(result);
  if (data?.placeId === 0) return "unpublished";
  if (!data?.placeId || !data.creatorId) return null;
  return String(data.creatorType).endsWith("Group")
    ? { groupId: String(data.creatorId) }
    : { userId: String(data.creatorId) };
}

/** Which place a Studio has open, from Studio's own list, so no script runs. Null once it's closed. */
async function placeIn(callTool: CallStudioTool, studioId: string): Promise<string | null> {
  const target = (await discoverStudioTargets(callTool)).targets.find(
    (candidate) => candidate.key === studioId,
  );
  if (!target) return null;
  // A local place has no ID, so its name is the best there is.
  return target.placeId ?? /\(placeId:\s*([1-9]\d*)\)\s*$/.exec(target.label)?.[1] ?? target.label;
}

// ── The model file ──────────────────────────────────────────────────────

export interface ModelFile {
  path: string;
  folder: string;
  fileName: string;
  name: string;
  bytes: Uint8Array;
  kind: "fbx" | "glb";
  hash: string;
}

/** What Roblox allows in a name, from a file name the AI chose. */
export function modelDisplayName(fileName: string): string {
  const name = basename(fileName, extname(fileName))
    .replace(/[^\p{L}\p{N} _-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return name || "Model";
}

/** The folder a linked model is in, so its file doesn't have to be read every time this is asked. */
export function modelFolder(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || !isOpenableUrl(parsed)) return null;
    const path = fileURLToPath(parsed);
    return MODEL_EXTENSIONS.has(extname(path).toLowerCase()) ? dirname(path) : null;
  } catch {
    return null;
  }
}

/** "\\server\share", "//server/share" or "\\?\UNC\server\share". Windows sends its sign-in to a share it reads. */
export const isNetworkPath = (path: string) =>
  /^[\\/]{2}/.test(path) && !/^[\\/]{2}[?.][\\/](?!UNC[\\/])/i.test(path);

/**
 * Where a path really leads, following each link by hand. realpath would already have reached a
 * network share by the time it said so. Null for a share, or for links that go on too long.
 */
export async function localTarget(path: string): Promise<string | null> {
  let pending = resolve(path);
  for (let links = 0; links < 32; links++) {
    if (isNetworkPath(pending)) return null;
    const { root } = parse(pending);
    const parts = pending.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    let next: string | null = null;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      if (!(await lstat(current)).isSymbolicLink()) continue;
      const target = await readlink(current);
      // Checked before resolving, which turns "//server" into "/server" on a Mac.
      if (isNetworkPath(target)) return null;
      next = resolve(dirname(current), target, ...parts.slice(index + 1));
      break;
    }
    if (next === null) return current;
    pending = next;
  }
  return null;
}

/** Reads a model a reply linked to. Null for anything else, so a link can't reach other files. */
export async function readModelFile(url: string): Promise<ModelFile | null> {
  let path: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:" || !isOpenableUrl(parsed)) return null;
    path = fileURLToPath(parsed);
  } catch {
    return null;
  }
  const extension = extname(path).toLowerCase();
  if (!MODEL_EXTENSIONS.has(extension)) return null;
  try {
    // A local-looking path can be a link to a share, and a card reads its file without a click.
    const target = await localTarget(path);
    if (!target) return null;
    const info = await stat(target);
    if (!info.isFile() || info.size > MAX_MODEL_BYTES) return null;
    const bytes = await readFile(target);
    return {
      path,
      folder: dirname(path),
      fileName: basename(path),
      name: modelDisplayName(path),
      bytes,
      kind: extension === ".fbx" ? "fbx" : "glb",
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

// ── What Roblox decided ─────────────────────────────────────────────────

export type Moderation = "approved" | "rejected" | "checking";

export function moderationOf(asset: unknown): Moderation {
  // The docs say MODERATION_STATE_APPROVED, and Roblox really answers Approved.
  const state = String((asset as any)?.moderationResult?.moderationState ?? "").toLowerCase();
  if (state.includes("approved")) return "approved";
  if (state.includes("rejected")) return "rejected";
  return "checking";
}

export interface SentModel {
  /** Null while Roblox hasn't said what it made, which `operationId` can still ask. */
  assetId: string | null;
  moderation: Moderation;
  operationId?: string;
  /** The game owner it was made for, like "user:1" or "group:2". */
  owner?: string;
}

/** Remembered by content: uploads are permanent, so the same bytes never go up twice. */
export const sentModelsFile = (root: string) => join(root, "roblox-sent-models.json");

/** Each owner's record is kept too, so another owner's upload doesn't hide the first one's. */
const ownedKey = (hash: string, owner: string) => `${hash}/${owner}`;

/**
 * The latest record for these bytes. With an owner, only one made for that owner, since an asset
 * belongs to the owner it was made for.
 */
export async function readSentModel(
  file: string,
  hash: string,
  owner?: string,
): Promise<SentModel | null> {
  try {
    const all = JSON.parse(await readFile(file, "utf8")) as Record<string, SentModel>;
    return (owner === undefined ? all[hash] : all[ownedKey(hash, owner)]) ?? null;
  } catch {
    return null;
  }
}

let sentModelWrites: Promise<unknown> = Promise.resolve();

/** One at a time, because two uploads finishing together would each overwrite the other's record. */
export function recordSentModel(file: string, hash: string, sent: SentModel): Promise<void> {
  const write = async () => {
    let all: Record<string, SentModel> = {};
    try {
      all = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    await mkdir(dirname(file), { recursive: true });
    const owned = sent.owner ? { [ownedKey(hash, sent.owner)]: sent } : {};
    await writeFile(`${file}.tmp`, JSON.stringify({ ...all, [hash]: sent, ...owned }));
    await rename(`${file}.tmp`, file);
  };
  const result = sentModelWrites.then(write, write);
  sentModelWrites = result.catch(() => {});
  return result;
}

// ── From the click to the place ─────────────────────────────────────────

const sending = new Map<string, Promise<void>>();

/** Runs one at a time for each key, in the order they were asked. */
const adding = new Map<string, Promise<ModelUploadResult>>();

function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const turn = (sending.get(key) ?? Promise.resolve()).then(run);
  const done = turn.then(
    () => {},
    () => {},
  );
  sending.set(key, done);
  void done.then(() => {
    if (sending.get(key) === done) sending.delete(key);
  });
  return turn;
}

export interface SendModelDeps {
  callTool: CallStudioTool;
  studioId: string;
  sentFile: string;
  /** The bytes the person looked at. Anything else in the file by now hasn't been checked. */
  expectedHash: string;
  /** From a card that says nothing will be uploaded: it may add what's on Roblox, never send more. */
  addOnly?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onStep?: (step: ModelUploadStep) => void;
}

/**
 * Sends a model to Roblox through Studio's own Open Cloud access, so BloxBot never holds a key. This
 * only runs from the card's button. It stops if the file isn't what was previewed, and it won't send
 * anything Roblox already has, since Open Cloud can't delete an upload.
 */
export async function sendModelToPlace(url: string, deps: SendModelDeps): Promise<ModelUploadResult> {
  const { callTool, studioId, sleep = wait, onStep } = deps;
  const file = await readModelFile(url);
  if (!file) return { status: "failed", reason: "no_file" };
  if (file.hash !== deps.expectedHash) return { status: "failed", reason: "file_changed" };

  // Roblox can take minutes, and the same Studio can open another place meanwhile. The model is for
  // the place that was open when the person pressed the button.
  const place = await placeIn(callTool, studioId).catch(() => null);
  if (!place) return { status: "failed", reason: "studio_error" };

  const addToPlace = async (assetId: string): Promise<ModelUploadResult> => {
    onStep?.("adding");
    const notAdded = (reason?: NotAddedReason): ModelUploadResult =>
      reason ? { status: "not_added", assetId, reason } : { status: "not_added", assetId };
    try {
      if ((await placeIn(callTool, studioId)) !== place) return notAdded("place_changed");
      const path = await insertUploadedModel(
        callTool,
        studioId,
        assetId,
        file.name,
        /^\d+$/.test(place) ? place : undefined,
      );
      return { status: "added", assetId, path };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return notAdded(
        message === STOP_PLAYTEST
          ? "playtest"
          : message === PLACE_CHANGED
            ? "place_changed"
            : undefined,
      );
    }
  };
  const moderationOfAsset = async (assetId: string): Promise<Moderation> => {
    for (let attempt = 0; attempt < MODERATION_POLLS; attempt++) {
      const asset = await callOpenCloud(callTool, studioId, {
        method: "GET",
        endpoint: `/assets/v1/assets/${encodeURIComponent(assetId)}`,
        scopes: ["asset:read"],
      });
      const moderation = moderationOf(asset);
      if (moderation !== "checking") return moderation;
      if (attempt < MODERATION_POLLS - 1) await sleep(MODERATION_POLL_MS);
    }
    return "checking";
  };
  const finishOperation = async (first: any, operationId: string | undefined) => {
    let operation = first;
    for (let attempt = 0; !operation?.done && operationId && attempt < OPERATION_POLLS; attempt++) {
      await sleep(OPERATION_POLL_MS);
      operation = await callOpenCloud(callTool, studioId, {
        method: "GET",
        endpoint: `/assets/v1/operations/${encodeURIComponent(operationId)}`,
        scopes: ["asset:read"],
      });
    }
    if (operation?.error) throw new OpenCloudError("file_rejected");
    if (!operation?.done) throw new OpenCloudError("studio_error");
    const assetId = operation.response?.assetId;
    if (!assetId) throw new OpenCloudError("file_rejected");
    return { assetId: String(assetId), moderation: moderationOf(operation.response) };
  };

  /** Finds what was already sent for this game's owner, or sends it and records Roblox's answer. */
  const findOrSend = async (): Promise<ModelUploadResult | { sent: SentModel; first?: unknown }> => {
    const creator = await readGameOwner(callTool, studioId).catch(() => null);
    if (creator === "unpublished") return { status: "needs_setup", access: "not_published" };
    if (!creator) return { status: "failed", reason: "studio_error" };
    // A turn spent waiting behind another upload of these bytes can end in a different place. The
    // owner just read has to be the pinned place's, since the asset will be theirs for good.
    if ((await placeIn(callTool, studioId).catch(() => null)) !== place) {
      return { status: "failed", reason: "place_changed" };
    }
    const owner = "groupId" in creator ? `group:${creator.groupId}` : `user:${creator.userId}`;
    const sent = await readSentModel(deps.sentFile, file.hash, owner);
    if (sent) return { sent };
    // Sent before, but for another owner's game, which can't use it. Uploading again is a new
    // permanent asset, so it takes its own click.
    if (deps.addOnly) return { status: "failed", reason: "other_owner" };
    onStep?.("uploading");
    // Studio reads the file itself, and the model's own file can change before it does. So it gets a
    // copy of the checked bytes, in the same folder because that's the one Studio approved. Each
    // upload gets its own, since two links can have the same bytes.
    const snapshot = join(file.folder, `.bloxbot-upload-${randomUUID()}.${file.kind}`);
    let operation: any;
    try {
      await writeFile(snapshot, file.bytes).catch(() => {
        throw new OpenCloudError("folder_unwritable");
      });
      operation = await callOpenCloud(callTool, studioId, {
          method: "POST",
        endpoint: "/assets/v1/assets",
        body: JSON.stringify({
          request: {
            assetType: "Model",
            displayName: file.name,
            description: "Made with BloxBot",
            creationContext: { creator },
          },
        }),
        files: [{ name: "fileContent", path: snapshot }],
        scopes: UPLOAD_SCOPES,
      });
    } finally {
      await rm(snapshot, { force: true }).catch(() => {});
    }
    // Roblox has it from here on, so whatever it said is kept before asking anything more. A failure
    // after this resumes rather than sending it again.
    const operationId: string | undefined =
      operation?.operationId ?? (String(operation?.path ?? "").split("/").at(-1) || undefined);
    const assetId = operation?.done && !operation.error ? operation.response?.assetId : undefined;
    if (!operationId && !assetId) {
      throw new OpenCloudError(operation?.done ? "file_rejected" : "studio_error");
    }
    const record: SentModel = assetId
      ? { assetId: String(assetId), moderation: moderationOf(operation.response), owner }
      : { assetId: null, moderation: "checking", operationId, owner };
    await recordSentModel(deps.sentFile, file.hash, record);
    onStep?.("checking");
    return { sent: record, first: operation };
  };

  try {
    // One upload of these bytes at a time until Roblox's answer is kept, so two links or two Studios
    // can't send the same file at once. The second finds the first one's record instead.
    const found = await oneAtATime(file.hash, findOrSend);
    if ("status" in found) return found;
    let { sent } = found;
    if (!sent.assetId && sent.operationId) {
      onStep?.("checking");
      const finished = await finishOperation(found.first ?? { done: false }, sent.operationId);
      sent = { ...finished, owner: sent.owner };
      await recordSentModel(deps.sentFile, file.hash, sent);
    }
    if (sent.assetId && sent.moderation === "checking") {
      onStep?.("checking");
      sent = { ...sent, moderation: await moderationOfAsset(sent.assetId) };
    }
    if (!sent.assetId) return { status: "failed", reason: "studio_error" };
    await recordSentModel(deps.sentFile, file.hash, sent);
    if (sent.moderation === "rejected") return { status: "rejected", assetId: sent.assetId };
    if (sent.moderation === "checking") return { status: "checking", assetId: sent.assetId };
    // Two cards for the same bytes could otherwise both find nothing in the place and both add it,
    // so an add already running for this asset and Studio is the answer for both.
    const key = `${studioId}\n${sent.assetId}`;
    const running = adding.get(key);
    if (running) return await running;
    const added = addToPlace(sent.assetId).finally(() => adding.delete(key));
    adding.set(key, added);
    return await added;
  } catch (error) {
    if (!(error instanceof OpenCloudError)) throw error;
    if (error.reason === "reopen_studio" || error.reason === "needs_permission") {
      return { status: "needs_setup", access: error.reason };
    }
    if (error.reason === "needs_folder") return { status: "needs_folder", folder: file.folder };
    if (error.reason === "token_rejected") return { status: "failed", reason: "refused" };
    return { status: "failed", reason: error.reason };
  }
}
