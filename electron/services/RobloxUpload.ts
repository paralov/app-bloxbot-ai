import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ModelUploadResult,
  ModelUploadStep,
  RobloxKeyCheck,
  RobloxUploadState,
} from "../../src/types/desktop";
import { isOpenableUrl } from "../openableUrl";

const API = "https://apis.roblox.com";
/** Open Cloud's limit for a model. */
export const MAX_MODEL_BYTES = 20 * 1024 * 1024;
const MODEL_TYPES: Record<string, string> = { ".fbx": "model/fbx", ".glb": "model/gltf-binary" };
const MAX_NAME_LENGTH = 50;
const POLL_EVERY_MS = 3_000;
const POLL_TIMES = 20;

export type Fetcher = typeof fetch;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type UploadFailure = "key_off" | "key_rejected" | "rate_limited" | "file_rejected" | "network";

export class RobloxUploadError extends Error {
  constructor(
    readonly reason: UploadFailure,
    message: string,
  ) {
    super(message);
    this.name = "RobloxUploadError";
  }
}

// ── The key ─────────────────────────────────────────────────────────────

interface Scope {
  name?: string;
  operations?: string[];
  userIds?: string[];
  groupIds?: string[];
}

export async function robloxUserName(id: string, fetcher: Fetcher = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const { name } = (await response.json()) as { name?: unknown };
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

/** Asks Roblox what a key can do. The key goes to Roblox and nowhere else, and errors never repeat it. */
export async function inspectRobloxKey(key: string, fetcher: Fetcher = fetch): Promise<RobloxKeyCheck> {
  let response: Response;
  try {
    response = await fetcher(`${API}/api-keys/v1/introspect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key }),
    });
  } catch {
    return { result: "unreachable" };
  }
  if (response.status >= 500 || response.status === 429) return { result: "unreachable" };
  if (!response.ok) return { result: "not_a_key" };

  const info = (await response.json()) as {
    authorizedUserId?: string | number;
    scopes?: Scope[];
    enabled?: boolean;
    expired?: boolean;
  };
  const ownerId = String(info.authorizedUserId ?? "");
  if (!ownerId) return { result: "not_a_key" };
  const scopes = info.scopes ?? [];
  const assetScopes = scopes.filter((scope) => scope.name === "asset");
  const operations = new Set(assetScopes.flatMap((scope) => scope.operations ?? []));
  return {
    result: "checked",
    ownerId,
    ownerName: await robloxUserName(ownerId, fetcher),
    active: info.enabled === true && info.expired !== true,
    canUpload: operations.has("read") && operations.has("write"),
    // Without Restrict by Creator a scope lists "*", which covers every group the owner is in.
    reachesGroups: assetScopes.some(
      (scope) =>
        (scope.groupIds?.length ?? 0) > 0 || (scope.userIds ?? []).some((id) => id !== ownerId),
    ),
    extraAccess: [...new Set(scopes.map((scope) => scope.name ?? "").filter((name) => name && name !== "asset"))],
    studio: null,
  };
}

export const keyIsUsable = (check: RobloxKeyCheck) =>
  check.result === "checked" && check.active && check.canUpload;

// ── Where it's kept ─────────────────────────────────────────────────────

export interface KeyEncryption {
  isEncryptionAvailable(): boolean;
  /** Linux can fall back to a fixed password, which isn't encryption. */
  getSelectedStorageBackend?(): string;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

interface StoredKey {
  ownerId: string;
  ownerName: string | null;
  key: string;
}

const canEncrypt = (encryption: KeyEncryption) =>
  encryption.isEncryptionAvailable() && encryption.getSelectedStorageBackend?.() !== "basic_text";

const readStored = async (file: string): Promise<StoredKey | null> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredKey;
  } catch {
    return null;
  }
};

export async function getRobloxUploadState(file: string, encryption: KeyEncryption): Promise<RobloxUploadState> {
  const stored = await readStored(file);
  if (stored) return { state: "on", ownerId: stored.ownerId, ownerName: stored.ownerName };
  return canEncrypt(encryption) ? { state: "off" } : { state: "unavailable" };
}

export async function saveRobloxKey(
  file: string,
  encryption: KeyEncryption,
  key: string,
  owner: { ownerId: string; ownerName: string | null },
): Promise<void> {
  if (!canEncrypt(encryption)) throw new Error("This computer can't store the key safely");
  await mkdir(dirname(file), { recursive: true });
  const stored: StoredKey = { ...owner, key: encryption.encryptString(key).toString("base64") };
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
}

export async function loadRobloxKey(file: string, encryption: KeyEncryption) {
  const stored = await readStored(file);
  if (!stored) return null;
  return { ...stored, key: encryption.decryptString(Buffer.from(stored.key, "base64")) };
}

export const forgetRobloxKey = (file: string) => rm(file, { force: true });

// ── The model file ──────────────────────────────────────────────────────

export interface ModelFile {
  path: string;
  fileName: string;
  name: string;
  bytes: Uint8Array;
  contentType: string;
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
  const contentType = MODEL_TYPES[extname(path).toLowerCase()];
  if (!contentType) return null;
  try {
    const { size, isFile } = await stat(path).then((info) => ({ size: info.size, isFile: info.isFile() }));
    if (!isFile || size > MAX_MODEL_BYTES) return null;
    const bytes = await readFile(path);
    return {
      path,
      fileName: basename(path),
      name: modelDisplayName(path),
      bytes,
      contentType,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return null;
  }
}

// ── The upload ──────────────────────────────────────────────────────────

export type Moderation = "approved" | "rejected" | "checking";

export function moderationOf(asset: unknown): Moderation {
  // The docs say MODERATION_STATE_APPROVED, and Roblox really answers Approved.
  const state = String((asset as any)?.moderationResult?.moderationState ?? "").toLowerCase();
  if (state.includes("approved")) return "approved";
  if (state.includes("rejected")) return "rejected";
  return "checking";
}

function failureFor(status: number): RobloxUploadError {
  if (status === 401 || status === 403) return new RobloxUploadError("key_rejected", "Roblox refused the key");
  if (status === 429) return new RobloxUploadError("rate_limited", "Roblox asked to slow down");
  if (status >= 500) return new RobloxUploadError("network", `Roblox had a problem (${status})`);
  return new RobloxUploadError("file_rejected", `Roblox refused the file (${status})`);
}

async function callRoblox(fetcher: Fetcher, path: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetcher(`${API}${path}`, init);
  } catch {
    throw new RobloxUploadError("network", "Couldn't reach Roblox");
  }
  if (!response.ok) throw failureFor(response.status);
  return (await response.json()) as any;
}

export async function checkModeration(
  assetId: string,
  key: string,
  options: { fetcher?: Fetcher; sleep?: (ms: number) => Promise<void>; times?: number } = {},
): Promise<Moderation> {
  const { fetcher = fetch, sleep = wait, times = POLL_TIMES } = options;
  for (let attempt = 0; attempt < times; attempt++) {
    const asset = await callRoblox(fetcher, `/assets/v1/assets/${encodeURIComponent(assetId)}?readMask=moderationResult`, {
      headers: { "x-api-key": key },
    });
    const moderation = moderationOf(asset);
    if (moderation !== "checking") return moderation;
    if (attempt < times - 1) await sleep(POLL_EVERY_MS);
  }
  return "checking";
}

/** Sends one file to the key owner's account and waits for Roblox to take it. */
export async function uploadModel(
  file: ModelFile,
  ownerId: string,
  key: string,
  options: { fetcher?: Fetcher; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ assetId: string; moderation: Moderation }> {
  const { fetcher = fetch, sleep = wait } = options;
  const request = JSON.stringify({
    assetType: "Model",
    displayName: file.name,
    description: "Made with BloxBot",
    creationContext: { creator: { userId: ownerId } },
  });
  const boundary = randomUUID().replaceAll("-", "");
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n${request}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="fileContent"; filename="${file.name}${extname(file.fileName)}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  let operation = await callRoblox(fetcher, "/assets/v1/assets", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const operationId = operation.operationId ?? String(operation.path ?? "").split("/").at(-1);
  for (let attempt = 0; !operation.done && attempt < POLL_TIMES; attempt++) {
    await sleep(POLL_EVERY_MS);
    operation = await callRoblox(fetcher, `/assets/v1/operations/${encodeURIComponent(operationId)}`, {
      headers: { "x-api-key": key },
    });
  }
  if (operation.error) {
    throw new RobloxUploadError("file_rejected", String(operation.error.message ?? "Roblox refused the file"));
  }
  if (!operation.done) throw new RobloxUploadError("network", "Roblox didn't finish in time");
  const assetId = operation.response?.assetId;
  if (!assetId) throw new RobloxUploadError("file_rejected", "Roblox didn't say what it made");
  const moderation = moderationOf(operation.response);
  return {
    assetId: String(assetId),
    moderation: moderation === "checking" ? await checkModeration(String(assetId), key, { fetcher, sleep }) : moderation,
  };
}

// ── What's been sent ────────────────────────────────────────────────────

export interface SentModel {
  assetId: string;
  moderation: Moderation;
}

/** Remembered by content, so the same bytes never go up twice, and a rejected model is never resent. */
export const sentModelsFile = (root: string) => join(root, "roblox-sent-models.json");

export async function readSentModel(file: string, hash: string): Promise<SentModel | null> {
  try {
    return (JSON.parse(await readFile(file, "utf8")) as Record<string, SentModel>)[hash] ?? null;
  } catch {
    return null;
  }
}

export async function recordSentModel(file: string, hash: string, sent: SentModel): Promise<void> {
  let all: Record<string, SentModel> = {};
  try {
    all = JSON.parse(await readFile(file, "utf8"));
  } catch {}
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...all, [hash]: sent }));
}

// ── From the click to the place ─────────────────────────────────────────

export interface SendModelDeps {
  keyFile: string;
  sentFile: string;
  encryption: KeyEncryption;
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** The account signed in to this Studio. Throws when Studio can't answer. */
  studioAccount: () => Promise<string>;
  insert: (assetId: string, name: string) => Promise<string>;
  onStep?: (step: ModelUploadStep) => void;
}

/**
 * The one way a model reaches Roblox. It only runs from the Upload button: the AI has no tool for it,
 * and it never sees the key. It stops before sending anything if the upload couldn't end up in the
 * place, because Studio can't load a model owned by another account.
 */
export async function sendModelToPlace(url: string, deps: SendModelDeps): Promise<ModelUploadResult> {
  const { fetcher = fetch, sleep = wait, onStep } = deps;
  const file = await readModelFile(url);
  if (!file) return { status: "failed", reason: "no_file" };
  const stored = await loadRobloxKey(deps.keyFile, deps.encryption);
  if (!stored) return { status: "failed", reason: "no_key" };

  const check = await inspectRobloxKey(stored.key, fetcher);
  if (check.result === "unreachable") return { status: "failed", reason: "network" };
  if (check.result !== "checked") return { status: "failed", reason: "key_rejected" };
  if (!check.active) return { status: "failed", reason: "key_off" };
  if (!check.canUpload) return { status: "failed", reason: "key_rejected" };

  let studioId: string;
  try {
    studioId = await deps.studioAccount();
  } catch {
    return { status: "failed", reason: "no_studio" };
  }
  if (studioId !== check.ownerId) {
    return {
      status: "wrong_account",
      keyOwner: check.ownerName ?? check.ownerId,
      studio: (await robloxUserName(studioId, fetcher)) ?? studioId,
    };
  }

  try {
    let sent = await readSentModel(deps.sentFile, file.hash);
    if (!sent) {
      onStep?.("uploading");
      sent = await uploadModel(file, check.ownerId, stored.key, {
        fetcher,
        sleep: async (ms) => {
          onStep?.("checking");
          await sleep(ms);
        },
      });
      await recordSentModel(deps.sentFile, file.hash, sent);
    } else if (sent.moderation === "checking") {
      onStep?.("checking");
      sent = { ...sent, moderation: await checkModeration(sent.assetId, stored.key, { fetcher, sleep }) };
      await recordSentModel(deps.sentFile, file.hash, sent);
    }
    if (sent.moderation === "rejected") return { status: "rejected", assetId: sent.assetId };
    if (sent.moderation === "checking") return { status: "checking", assetId: sent.assetId };

    onStep?.("adding");
    try {
      return { status: "added", assetId: sent.assetId, path: await deps.insert(sent.assetId, file.name) };
    } catch {
      return { status: "not_added", assetId: sent.assetId };
    }
  } catch (error) {
    if (error instanceof RobloxUploadError) return { status: "failed", reason: error.reason };
    throw error;
  }
}
