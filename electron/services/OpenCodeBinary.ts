import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { Data, Effect, Either, Schema } from "effect";
import extractZip from "extract-zip";
import { x as extractTar } from "tar";

import type { OpenCodeStartupProgress } from "../../src/types/desktop";
import { PINNED_OPENCODE_RELEASE, type PinnedOpenCodeRelease } from "./openCodePinnedRelease";

const OPEN_CODE_API = "https://api.github.com/repos/anomalyco/opencode/releases";
const OPEN_CODE_DOWNLOAD_PREFIX = "https://github.com/anomalyco/opencode/releases/download/";
// OpenCode's API isn't stable across minor releases and ships several times a week, so BloxBot
// follows patches of the line its client was built against. Update `@opencode/client` to move on.
const SUPPORTED_MAJOR = 2;
const SUPPORTED_MINOR = 2;
const RELEASES_PER_PAGE = 100;
const LOOKUP_TIMEOUT_MS = 15_000;
/**
 * How long a download may go without a byte before it counts as dead. There is no limit on total
 * time, so a slow connection can finish. This outlasts TCP retransmission backoff and security
 * software that holds a download back while it scans, and a dead connection still fails faster
 * than the old 120 second limit did.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000;
/** How many tries in a row may get nothing more before a download counts as failed. */
const DOWNLOAD_RESUMES = 3;
const SAVE_DOWNLOAD_EVERY_BYTES = 16 * 1024 ** 2;
const ABANDONED_INSTALL_AGE_MS = 60 * 60 * 1000;
/** The Windows archive unpacks to a ~180 MB executable; leave room for the archive and a margin. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;
const EXTRACT_ATTEMPTS = 3;
/** Error codes Windows returns while antivirus software scans or locks a new file. */
const LOCKED_CODES = new Set(["EPERM", "EBUSY", "EACCES", "UNKNOWN"]);
const DENIED_CODES = new Set(["EPERM", "EACCES"]);
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const VIRUS_PATTERN = /virus|potentially unwanted/i;
/**
 * TLS errors meaning Node doesn't know who issued a certificate, as when corporate or antivirus
 * software intercepts HTTPS with its own root. Expired or wrong-host certificates aren't here:
 * another certificate store wouldn't fix those.
 */
const UNKNOWN_ISSUER_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
]);

const GitHubAssetSchema = Schema.mutable(
  Schema.Struct({
    name: Schema.String,
    browser_download_url: Schema.String,
    digest: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const GitHubReleaseSchema = Schema.mutable(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    prerelease: Schema.Boolean,
    assets: Schema.mutable(Schema.Array(GitHubAssetSchema)),
  }),
);

const GitHubReleasesSchema = Schema.mutable(Schema.Array(GitHubReleaseSchema));

export type GitHubRelease = typeof GitHubReleaseSchema.Type;
type GitHubAsset = typeof GitHubAssetSchema.Type;

interface Version {
  major: number;
  minor: number;
  patch: number;
  value: string;
}

interface AssetSpec {
  archiveName: string;
  executableName: string;
  format: "tar.gz" | "zip";
}

interface CompatibleRelease {
  version: Version;
  asset: GitHubAsset;
  archiveSha256: string;
}

const CacheMetadataSchema = Schema.mutable(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    version: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    assetName: Schema.String,
    archiveSha256: Schema.String,
    binarySha256: Schema.String,
  }),
);

type CacheMetadata = typeof CacheMetadataSchema.Type;

export interface OpenCodeBinary {
  executable: string;
  version: string;
}

/** Why installing OpenCode failed, for the setup error screen and error reports. */
export type OpenCodeInstallFailureReason =
  | "blocked_by_security"
  | "disk_full"
  | "network"
  | "other";

export class OpenCodeBinaryError extends Data.TaggedError("OpenCodeBinaryError")<{
  message: string;
  cause?: unknown;
  reason?: OpenCodeInstallFailureReason;
}> {}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Resolves with each extracted file's expected size in bytes, when the format records it. */
type ExtractArchive = (
  archivePath: string,
  destination: string,
  format: AssetSpec["format"],
) => Promise<ReadonlyMap<string, number> | void>;
type StartupProgressReporter = (progress: OpenCodeStartupProgress) => void;

/** The filesystem calls an install makes that tests replace to simulate Windows failures. */
export interface OpenCodeInstallFileSystem {
  rename: (from: string, to: string) => Promise<void>;
  /** Deletes a folder and everything in it. */
  remove: (path: string) => Promise<void>;
  stat: (path: string) => Promise<{ isFile(): boolean; size: number }>;
  /** Free bytes available on the volume that holds `path`, or null when unknown. */
  freeBytes: (path: string) => Promise<number | null>;
}

/** Pauses between install retries, in milliseconds. */
export interface OpenCodeInstallDelays {
  /** Before the 2nd and 3rd extract attempts. */
  extractRetryMs: readonly number[];
  /** Before re-checking that the extracted executable still exists. */
  verifyMs: number;
  /** Before each publish (rename) attempt after the first, which also sets how many there are. */
  renameRetryMs: readonly number[];
  /** Before each try after a download drops, which sets how long a dropped connection can last. */
  resumeMs: readonly number[];
}

const DEFAULT_DELAYS: OpenCodeInstallDelays = {
  extractRetryMs: [1_000, 3_000],
  verifyMs: 500,
  // About 30 seconds. Scanning a new 180 MB executable can hold its folder far longer than a blip.
  renameRetryMs: [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000],
  // Long enough to outlast a dropped Wi-Fi connection before calling it failed.
  resumeMs: [5_000, 15_000, 30_000],
};

async function defaultFreeBytes(path: string): Promise<number | null> {
  // statfs is missing from older Node releases and can fail on some network drives.
  if (typeof statfs !== "function") return null;
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

const DEFAULT_FILE_SYSTEM: OpenCodeInstallFileSystem = {
  rename,
  remove: (path) => rm(path, { recursive: true, force: true }),
  stat,
  freeBytes: defaultFreeBytes,
};

export interface OpenCodeBinaryOptions {
  cacheDirectory: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: Fetch;
  /**
   * Retries a download Node refused over an unknown certificate issuer, using the operating
   * system's certificates. The archive still has to match the same SHA-256.
   */
  fetchWithSystemCertificates?: Fetch;
  extractArchive?: ExtractArchive;
  onStartupProgress?: StartupProgressReporter;
  /** Defaults to {@link PINNED_OPENCODE_RELEASE}. */
  pinnedRelease?: PinnedOpenCodeRelease;
  fileSystem?: Partial<OpenCodeInstallFileSystem>;
  delays?: Partial<OpenCodeInstallDelays>;
}

const fail = (message: string, cause?: unknown, reason?: OpenCodeInstallFailureReason) =>
  Effect.fail(new OpenCodeBinaryError({ message, cause, reason }));

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The errno code and message, e.g. "EPERM: operation not permitted, open '…'". */
export function describeCause(cause: unknown): string {
  const code = errorCode(cause);
  const text = errorText(cause) || (cause instanceof Error ? cause.name : "");
  if (!code || text.includes(code)) return text;
  return text ? `${code}: ${text}` : code;
}

function mentionsVirus(cause: unknown): boolean {
  return VIRUS_PATTERN.test(errorText(cause));
}

/** Reason for a failed filesystem step. `repeated` means it kept failing through retries. */
function classifyFileError(cause: unknown, repeated = false): OpenCodeInstallFailureReason {
  const code = errorCode(cause);
  if (code === "ENOSPC") return "disk_full";
  if (mentionsVirus(cause)) return "blocked_by_security";
  // A lock that outlasts every retry is almost always security software holding the file.
  if (repeated && code && (DENIED_CODES.has(code) || LOCKED_CODES.has(code))) {
    return "blocked_by_security";
  }
  return "other";
}

function hasUnknownIssuer(cause: unknown): boolean {
  // Node's fetch rejects with "fetch failed" and puts the TLS error in `cause`.
  const code = cause instanceof Error ? errorCode(cause.cause) : undefined;
  return code !== undefined && UNKNOWN_ISSUER_CODES.has(code);
}

/**
 * Chromium's network stack also knows the system's proxy settings, which Node doesn't, so any failed
 * connection is worth one try through it. Not a cancelled request, or a certificate that's plainly
 * bad, which another store wouldn't change. The archive still has to match the same SHA-256.
 */
function worthTheSystemNetwork(cause: unknown): boolean {
  if (hasUnknownIssuer(cause)) return true;
  if (!(cause instanceof TypeError)) return false;
  const code = errorCode(cause.cause);
  return code === undefined || !/^(CERT_|ERR_TLS_|DEPTH_ZERO|SELF_SIGNED)/.test(code);
}

/**
 * Node stays the first choice so most people's downloads don't change. Only a request it refused
 * over the issuer goes to the fallback, and any other failure is reported as it happened.
 */
function withCertificateFallback(fetchFn: Fetch, fallback: Fetch | undefined): Fetch {
  if (!fallback) return fetchFn;
  return (url, init) =>
    fetchFn(url, init).catch((cause: unknown) => {
      if (!worthTheSystemNetwork(cause)) throw cause;
      return fallback(url, init);
    });
}

const tryPromise = <A>(message: string, evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new OpenCodeBinaryError({
        message: `${message}: ${describeCause(cause)}`,
        cause,
        reason: classifyFileError(cause),
      }),
  });

function contentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header === null) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

class DownloadStalledError extends Error {}

/** Aborts its signal when `touch` hasn't been called for `timeoutMs`. Call `stop` when finished. */
function watchForStall(timeoutMs: number, receivedBytes: () => number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => clearTimeout(timer);
  const touch = () => {
    stop();
    timer = setTimeout(() => {
      const receivedMb = (receivedBytes() / 1024 ** 2).toFixed(1);
      controller.abort(
        new DownloadStalledError(
          `stalled, no data for ${timeoutMs / 1000} seconds (${receivedMb} MB received)`,
        ),
      );
    }, timeoutMs);
  };
  touch();

  return { signal: controller.signal, touch, stop };
}

/** What has arrived so far, kept across attempts so a dropped connection doesn't lose it. */
interface PartialDownload {
  chunks: Uint8Array[];
  bytes: number;
  totalBytes: number | null;
}

async function readDownload(
  response: Response,
  partial: PartialDownload,
  signal: AbortSignal,
  onData: () => void,
  savedPath: string,
  reportProgress?: StartupProgressReporter,
): Promise<Buffer | undefined> {
  if (!response.body) return undefined;

  partial.totalBytes ??= response.status === 206 ? totalFromRange(response) : contentLength(response);
  const reader = response.body.getReader();
  const startedAt = Date.now();
  let bytesThisAttempt = 0;
  let savedBytes = partial.bytes;
  let lastReportAt = startedAt;

  const report = (now: number) => {
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
    reportProgress?.({
      phase: "downloading",
      downloadedBytes: partial.bytes,
      totalBytes: partial.totalBytes,
      bytesPerSecond: Math.round(bytesThisAttempt / elapsedSeconds),
    });
  };
  const abortRead = () => void reader.cancel(signal.reason).catch(() => {});

  signal.addEventListener("abort", abortRead, { once: true });
  report(startedAt);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;

      partial.chunks.push(value);
      partial.bytes += value.byteLength;
      bytesThisAttempt += value.byteLength;
      if (value.byteLength > 0) onData();
      // Kept as it arrives, since closing the app gives nothing a chance to save it on the way out.
      if (partial.bytes - savedBytes >= SAVE_DOWNLOAD_EVERY_BYTES) {
        await saveDownload(savedPath, Buffer.concat(partial.chunks, partial.bytes));
        savedBytes = partial.bytes;
      }
      const now = Date.now();
      if (now - lastReportAt >= 100) {
        report(now);
        lastReportAt = now;
      }
    }
    report(Date.now());
    return Buffer.concat(partial.chunks, partial.bytes);
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
  }
}

/** How big the whole file is, by a 206 response's own account. */
function totalFromRange(response: Response): number | null {
  const match = /\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

/** Where a 206 response says its bytes start. */
function resumedFrom(response: Response): number | null {
  const match = /^bytes (\d+)-/.exec(response.headers.get("content-range") ?? "");
  return match ? Number(match[1]) : null;
}

/** Worth doing but never worth failing over, since all it saves is downloading again. */
async function saveDownload(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
    .then(() => writeFile(path, data))
    .catch(() => {});
}

/**
 * Clears what was saved for this release and older ones. A newer release's download stays, since
 * a failed lookup can install an older release while the newer one is still worth resuming.
 */
async function removeOtherSavedDownloads(
  keep: string,
  archiveName: string,
  installed: Version,
): Promise<void> {
  const directory = dirname(keep);
  const names = await readdir(directory).catch(() => [] as string[]);
  const isNewer = (name: string) => {
    const tag = /^(\d+\.\d+\.\d+)\./.exec(name.slice(archiveName.length + 1))?.[1];
    const version = tag ? parseVersion(tag) : null;
    return version !== null && compareVersions(version, installed) > 0;
  };
  await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith(`${archiveName}.`) && join(directory, name) !== keep && !isNewer(name),
      )
      .map((name) => rm(join(directory, name), { force: true }).catch(() => {})),
  );
}

const emptyDownload = (): PartialDownload => ({ chunks: [], bytes: 0, totalBytes: null });

/** What an earlier attempt saved, which counts for nothing if it can't be read. */
async function readSavedDownload(path: string): Promise<PartialDownload> {
  try {
    const saved = await readFile(path);
    return { chunks: [saved], bytes: saved.byteLength, totalBytes: null };
  } catch {
    return emptyDownload();
  }
}

/**
 * Downloads a file, carrying on from where it stopped if the connection drops or stalls: on a slow
 * connection, starting over can mean never finishing. What arrived is saved if the attempts run out,
 * so trying again later carries on too. The caller's SHA-256 check covers the joined result, and a
 * server that won't resume just sends the whole file again.
 */
async function downloadWithResume(
  url: string,
  fetchFn: Fetch,
  signal: AbortSignal,
  savedPath: string,
  resumeDelaysMs: readonly number[],
  reportProgress?: StartupProgressReporter,
): Promise<{ archiveBuffer: Buffer | undefined; response: Response }> {
  let partial = await readSavedDownload(savedPath);
  // Any new data starts the count over, so only a connection that's really gone runs it out.
  let resumes = 0;
  let bytesAtLastFailure = partial.bytes;
  for (;;) {
    const stall = watchForStall(DOWNLOAD_STALL_TIMEOUT_MS, () => partial.bytes);
    // Said before the first byte, because that wait can be the long one.
    reportProgress?.({
      phase: "downloading",
      downloadedBytes: partial.bytes,
      totalBytes: partial.totalBytes,
      bytesPerSecond: 0,
    });
    try {
      const downloadSignal = AbortSignal.any([signal, stall.signal]);
      const response = await fetchFn(url, {
        headers: {
          "User-Agent": "BloxBot",
          ...(partial.bytes > 0 ? { Range: `bytes=${partial.bytes}-` } : {}),
        },
        signal: downloadSignal,
      });
      stall.touch();
      // What we asked for is past the end of the file, so what was saved isn't from this file.
      if (response.status === 416 && partial.bytes > 0) {
        await response.body?.cancel().catch(() => {});
        partial = emptyDownload();
        bytesAtLastFailure = 0;
        if (resumes++ < DOWNLOAD_RESUMES) continue;
      }
      // With data in hand, a passing error shouldn't cost it, so this goes the way a drop does.
      if (!response.ok && partial.bytes > 0) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`the server answered ${response.status}`);
      }
      if (!response.ok) return { archiveBuffer: undefined, response };
      if (partial.bytes > 0 && resumedFrom(response) !== partial.bytes) {
        if (response.status === 206) {
          // Bytes from somewhere else: nothing here can use them, so ask for the whole file.
          await response.body?.cancel().catch(() => {});
          partial = emptyDownload();
          bytesAtLastFailure = 0;
          if (resumes++ < DOWNLOAD_RESUMES) continue;
          throw new Error("the server sent the wrong part of the file");
        }
        partial = emptyDownload();
      }
      return {
        archiveBuffer: await readDownload(
          response,
          partial,
          downloadSignal,
          stall.touch,
          savedPath,
          reportProgress,
        ),
        response,
      };
    } catch (cause) {
      if (partial.bytes > bytesAtLastFailure) resumes = 0;
      bytesAtLastFailure = partial.bytes;
      if (signal.aborted || resumes >= DOWNLOAD_RESUMES) {
        if (partial.bytes > 0) {
          await saveDownload(savedPath, Buffer.concat(partial.chunks, partial.bytes));
        }
        throw cause;
      }
      resumes += 1;
      // A moment for a connection that just dropped, or every try would land in the same blip.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        // A long download can retry many times, so each wait takes its listener with it.
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, resumeDelaysMs[resumes - 1] ?? 0);
        signal.addEventListener("abort", onAbort, { once: true });
      }).catch(async (reason: unknown) => {
        if (partial.bytes > 0) {
          await saveDownload(savedPath, Buffer.concat(partial.chunks, partial.bytes));
        }
        throw reason;
      });
    } finally {
      stall.stop();
    }
  }
}

function parseVersion(tag: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!match) return null;

  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    value: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
  };
  return version.major === SUPPORTED_MAJOR && version.minor === SUPPORTED_MINOR ? version : null;
}

function compareVersions(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function getOpenCodeAssetSpec(
  platform: NodeJS.Platform,
  arch: string,
): Effect.Effect<AssetSpec, OpenCodeBinaryError> {
  if (platform === "darwin" && arch === "arm64") {
    return Effect.succeed({
      archiveName: "opencode-darwin-arm64.zip",
      executableName: "opencode",
      format: "zip",
    });
  }
  if (platform === "win32" && arch === "x64") {
    return Effect.succeed({
      archiveName: "opencode-windows-x64.zip",
      executableName: "opencode.exe",
      format: "zip",
    });
  }
  if (platform === "linux" && arch === "x64") {
    return Effect.succeed({
      archiveName: "opencode-linux-x64.tar.gz",
      executableName: "opencode",
      format: "tar.gz",
    });
  }
  return fail(`OpenCode does not provide a supported binary for ${platform}/${arch}`);
}

export function selectCompatibleRelease(
  releases: GitHubRelease[],
  archiveName: string,
  avoid: readonly string[] = [],
): CompatibleRelease | null {
  const candidates = releases.flatMap((release): CompatibleRelease[] => {
    if (release.draft || release.prerelease) return [];
    const version = parseVersion(release.tag_name);
    if (!version || avoid.includes(version.value)) return [];

    const asset = release.assets.find((candidate) => candidate.name === archiveName);
    const digest = asset?.digest?.match(/^sha256:([a-f\d]{64})$/i)?.[1]?.toLowerCase();
    if (!asset || !digest || !asset.browser_download_url.startsWith(OPEN_CODE_DOWNLOAD_PREFIX)) {
      return [];
    }
    return [{ version, asset, archiveSha256: digest }];
  });

  return candidates.sort((left, right) => compareVersions(right.version, left.version))[0] ?? null;
}

/** Short, report-friendly text for why a fetch failed: timeout, DNS or network error. */
export function describeNetworkError(cause: unknown, timeoutMs: number): string {
  if (cause instanceof DownloadStalledError) return cause.message;
  if (cause instanceof Error || cause instanceof DOMException) {
    if (cause.name === "TimeoutError") return `timed out after ${timeoutMs / 1000} seconds`;
    if (cause.name === "AbortError") return "aborted";
  }
  if (cause instanceof Error) {
    // Node's fetch rejects with "fetch failed" and puts the DNS/socket error in `cause`.
    const inner = cause.cause;
    const innerText =
      inner instanceof Error
        ? inner.message || ("code" in inner ? String(inner.code) : inner.name)
        : null;
    return innerText && !cause.message.includes(innerText)
      ? `${cause.message} (${innerText})`
      : cause.message || cause.name;
  }
  return String(cause);
}

function describeHttpFailure(response: Response): string {
  const remaining = response.headers.get("x-ratelimit-remaining");
  return remaining === null
    ? `HTTP ${response.status}`
    : `HTTP ${response.status}, x-ratelimit-remaining ${remaining}`;
}

const tryNetwork = <A>(
  message: string,
  timeoutMs: number,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new OpenCodeBinaryError({
        message: `${message}: ${describeNetworkError(cause, timeoutMs)}`,
        cause,
        reason: "network",
      }),
  });

/**
 * Makes exactly one request to GitHub's release API. Unauthenticated, that API allows 60
 * requests an hour per IP, so a failure here must never block a cached or pinned copy.
 */
function findCompatibleRelease(fetchFn: Fetch, archiveName: string, avoid?: readonly string[]) {
  return Effect.gen(function* () {
    const { releasesJson, response } = yield* tryNetwork(
      "GitHub release lookup failed",
      LOOKUP_TIMEOUT_MS,
      async (signal) => {
        const response = await fetchFn(`${OPEN_CODE_API}?per_page=${RELEASES_PER_PAGE}`, {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "BloxBot",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]),
        });
        return {
          releasesJson: response.ok ? await response.json() : undefined,
          response,
        };
      },
    );
    if (!response.ok) {
      return yield* fail(
        `GitHub release lookup failed with ${describeHttpFailure(response)}`,
        undefined,
        "network",
      );
    }

    const releases = yield* Schema.decodeUnknown(GitHubReleasesSchema)(releasesJson).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeBinaryError({ message: "GitHub returned an invalid release list", cause }),
      ),
    );

    const release = selectCompatibleRelease(releases, archiveName, avoid);
    if (release) return release;
    return yield* fail(
      `No stable OpenCode ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x release is available for ${archiveName}`,
    );
  });
}

function sha256File(path: string): Effect.Effect<string, OpenCodeBinaryError> {
  return Effect.async<string, OpenCodeBinaryError>((resume) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(
        Effect.fail(
          new OpenCodeBinaryError({
            message: `Failed to hash ${path}: ${describeCause(cause)}`,
            cause,
            reason: classifyFileError(cause),
          }),
        ),
      );
    };
    const onData = (chunk: Buffer) => hash.update(chunk);
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(hash.digest("hex")));
    };

    stream.once("error", onError);
    stream.on("data", onData);
    stream.once("end", onEnd);

    return Effect.sync(() => {
      cleanup();
      stream.destroy();
    });
  });
}

function readValidCachedBinary(
  versionDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
  expected?: CompatibleRelease,
): Effect.Effect<OpenCodeBinary | null, never> {
  return Effect.gen(function* () {
    const contents = yield* tryPromise("Failed to read cached OpenCode metadata", () =>
      readFile(join(versionDirectory, "metadata.json"), "utf8"),
    );
    const metadataJson = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) =>
        new OpenCodeBinaryError({ message: "Cached OpenCode metadata is invalid JSON", cause }),
    });
    const metadata = yield* Schema.decodeUnknown(CacheMetadataSchema)(metadataJson).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeBinaryError({ message: "Cached OpenCode metadata is invalid", cause }),
      ),
    );
    if (!parseVersion(metadata.version)) return null;
    if (metadata.platform !== platform || metadata.arch !== arch) return null;
    if (metadata.assetName !== spec.archiveName) return null;
    if (
      expected &&
      (metadata.version !== expected.version.value ||
        metadata.archiveSha256 !== expected.archiveSha256)
    ) {
      return null;
    }

    const executable = join(versionDirectory, spec.executableName);
    const executableStat = yield* tryPromise("Failed to inspect cached OpenCode binary", () =>
      stat(executable),
    );
    if (!executableStat.isFile()) return null;
    if ((yield* sha256File(executable)) !== metadata.binarySha256) return null;
    if (platform !== "win32") {
      yield* tryPromise("Failed to make the cached OpenCode binary executable", () =>
        chmod(executable, 0o755),
      );
    }
    return { executable, version: metadata.version };
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

const CACHE_NOTES_FILE = "cache-notes.json";
/** Far longer than a change holds the lock, which is a read and a write of a few bytes. */
const CACHE_NOTES_LOCK_STALE_MS = 10_000;
const CACHE_NOTES_LOCK_RETRY_MS = 20;

/** What's learned about versions between launches. None of it is needed to work, just to choose well. */
interface CacheNotes {
  /** Passed its checks but wouldn't run here, while an older one did. */
  distrusted: string[];
  /** The newest release GitHub still offers, since one that's been withdrawn shouldn't keep running. */
  latest?: string;
}

async function readCacheNotes(platformDirectory: string): Promise<CacheNotes> {
  try {
    const notes = JSON.parse(await readFile(join(platformDirectory, CACHE_NOTES_FILE), "utf8"));
    return {
      distrusted: Array.isArray(notes.distrusted) ? notes.distrusted : [],
      latest: typeof notes.latest === "string" ? notes.latest : undefined,
    };
  } catch {
    return { distrusted: [] };
  }
}

/** Takes the notes' lock file, or says it couldn't. It's held only for one read and one write. */
async function lockCacheNotes(lock: string): Promise<boolean> {
  const deadline = Date.now() + CACHE_NOTES_LOCK_STALE_MS * 2;
  while (Date.now() < deadline) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") return false;
    }
    // A BloxBot that quit while holding the lock would otherwise block every change after it.
    const held = await stat(lock).then(
      ({ mtimeMs }) => Date.now() - mtimeMs,
      () => 0,
    );
    if (held > CACHE_NOTES_LOCK_STALE_MS) await rm(lock, { force: true }).catch(() => {});
    else await new Promise((resolve) => setTimeout(resolve, CACHE_NOTES_LOCK_RETRY_MS));
  }
  return false;
}

/**
 * Another running BloxBot can change the notes at the same moment, so a change reads and writes
 * under a lock file, or a stale read could drop a version the other one just distrusted. The new
 * notes land through a rename, so a read without the lock never sees half a file.
 */
async function updateCacheNotes(
  platformDirectory: string,
  change: (notes: CacheNotes) => CacheNotes,
): Promise<void> {
  const path = join(platformDirectory, CACHE_NOTES_FILE);
  const lock = `${path}.lock`;
  if (!(await lockCacheNotes(lock))) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const notes = change(await readCacheNotes(platformDirectory));
    await writeFile(temporary, JSON.stringify(notes));
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  } finally {
    await rm(lock, { force: true }).catch(() => {});
  }
}

/** Quitting during a background install leaves its folder behind. An hour is well past any in use. */
async function sweepAbandonedInstalls(platformDirectory: string): Promise<void> {
  const names = await readdir(platformDirectory).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(".download-"))
      .map(async (name) => {
        const path = join(platformDirectory, name);
        const { mtimeMs } = await stat(path);
        if (Date.now() - mtimeMs > ABANDONED_INSTALL_AGE_MS) {
          await rm(path, { recursive: true, force: true });
        }
      })
      .map((sweep) => sweep.catch(() => {})),
  );
}

function findNewestCachedBinary(
  platformDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
  avoid: readonly string[] = [],
): Effect.Effect<OpenCodeBinary | null, never> {
  return Effect.gen(function* () {
    const notes = yield* Effect.promise(() => readCacheNotes(platformDirectory));
    const latest = notes.latest ? parseVersion(notes.latest) : null;
    const usable = (version: Version) =>
      !avoid.includes(version.value) && !notes.distrusted.includes(version.value);
    const entries = yield* tryPromise("Failed to inspect the OpenCode cache", () =>
      readdir(platformDirectory, { withFileTypes: true }),
    );
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseVersion(entry.name))
      .filter((version): version is Version => version !== null)
      .sort((left, right) => compareVersions(right, left));

    // Withdrawn ones go last, not away: an old copy still beats nothing at all.
    const stillOffered = (version: Version) => !latest || compareVersions(version, latest) <= 0;
    const inOrder = [
      ...versions.filter((version) => usable(version) && stillOffered(version)),
      ...versions.filter((version) => usable(version) && !stillOffered(version)),
    ];
    for (const version of inOrder) {
      const cached = yield* readValidCachedBinary(
        join(platformDirectory, version.value),
        platform,
        arch,
        spec,
      );
      if (cached) return cached;
    }
    return null;
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

const defaultExtractArchive: ExtractArchive = async (archivePath, destination, format) => {
  if (format !== "zip") {
    await extractTar({ file: archivePath, cwd: destination, strict: true });
    return undefined;
  }
  const sizes = new Map<string, number>();
  await extractZip(archivePath, {
    dir: destination,
    onEntry: (entry) => {
      sizes.set(entry.fileName, entry.uncompressedSize);
    },
  });
  return sizes;
};

interface InstallContext {
  platformDirectory: string;
  partialDirectory: string;
  platform: NodeJS.Platform;
  arch: string;
  spec: AssetSpec;
  downloadFetch: Fetch;
  extractArchive: ExtractArchive;
  fileSystem: OpenCodeInstallFileSystem;
  delays: OpenCodeInstallDelays;
  reportProgress?: StartupProgressReporter;
}

const sleep = (ms: number) => (ms > 0 ? Effect.sleep(`${ms} millis`) : Effect.void);

/** Free megabytes when the drive is below {@link MIN_FREE_BYTES}, or null when it has room or can't be read. */
function lowFreeSpaceMb(context: InstallContext): Effect.Effect<number | null> {
  return Effect.tryPromise(() => context.fileSystem.freeBytes(context.platformDirectory)).pipe(
    Effect.map((freeBytes) =>
      freeBytes === null || !Number.isFinite(freeBytes) || freeBytes >= MIN_FREE_BYTES
        ? null
        : Math.floor(freeBytes / 1024 ** 2),
    ),
    Effect.orElseSucceed(() => null),
  );
}

function requireFreeSpace(context: InstallContext) {
  return Effect.gen(function* () {
    const freeMb = yield* lowFreeSpaceMb(context);
    if (freeMb === null) return;
    return yield* fail(
      `Not enough free disk space to install OpenCode: ${freeMb} MB free, ${MIN_FREE_BYTES / 1024 ** 2} MB needed`,
      undefined,
      "disk_full",
    );
  });
}

/** Why the extracted executable is missing or incomplete, or null when it looks whole. */
function inspectExecutable(
  context: InstallContext,
  executable: string,
  expectedSize: number | undefined,
): Effect.Effect<string | null, OpenCodeBinaryError> {
  const name = context.spec.executableName;
  return Effect.tryPromise(() => context.fileSystem.stat(executable)).pipe(
    Effect.map((executableStat) => {
      if (!executableStat.isFile()) return `${name} is not a file`;
      if (executableStat.size === 0) return `${name} is empty`;
      if (expectedSize !== undefined && executableStat.size < expectedSize) {
        return `${name} is ${executableStat.size} of ${expectedSize} bytes`;
      }
      return null;
    }),
    Effect.catchAll(({ error }) => {
      const code = errorCode(error);
      if (code === "ENOENT") return Effect.succeed(`${name} is missing`);
      // Security software scanning the new file can briefly lock it; retry like an extract lock.
      if (code !== undefined && LOCKED_CODES.has(code)) {
        return Effect.succeed(`${name} is locked (${code})`);
      }
      return Effect.fail(
            new OpenCodeBinaryError({
              message: `Failed to inspect the extracted OpenCode binary: ${describeCause(error)}`,
              cause: error,
              reason: classifyFileError(error),
            }),
          );
    }),
  );
}

type ExtractAttempt =
  | { _tag: "Extracted"; installDirectory: string }
  | { _tag: "Retry"; error: OpenCodeBinaryError };

/**
 * Extracts into a fresh directory, then checks the executable is there and stays there.
 * Antivirus software on Windows often locks or quarantines a new unsigned executable, so
 * those failures are worth another attempt. Anything else fails at once.
 */
function extractOnce(
  context: InstallContext,
  archivePath: string,
  installDirectory: string,
): Effect.Effect<ExtractAttempt, OpenCodeBinaryError> {
  const { spec } = context;
  const executable = join(installDirectory, spec.executableName);
  // The archive passed SHA-256 verification before extraction, so a missing, empty or short
  // executable can't come from a truncated download. It means the drive filled up during
  // extraction, or security software removed or locked the file.
  const incomplete = (problem: string) =>
    Effect.gen(function* () {
      const freeMb = yield* lowFreeSpaceMb(context);
      if (freeMb !== null) {
        return yield* fail(
          `Failed to extract the OpenCode archive: ${problem} after extraction with ${freeMb} MB free, ${MIN_FREE_BYTES / 1024 ** 2} MB needed`,
          undefined,
          "disk_full",
        );
      }
      return {
        _tag: "Retry",
        error: new OpenCodeBinaryError({
          message: `Failed to extract the OpenCode archive: ${problem} after extraction, likely removed by security software`,
          reason: "blocked_by_security",
        }),
      } satisfies ExtractAttempt;
    });

  return Effect.gen(function* () {
    yield* tryPromise("Failed to create the OpenCode installation directory", async () => {
      await rm(installDirectory, { recursive: true, force: true });
      await mkdir(installDirectory, { recursive: true });
    });

    const extracted = yield* Effect.either(
      Effect.tryPromise(() => context.extractArchive(archivePath, installDirectory, spec.format)),
    );
    if (Either.isLeft(extracted)) {
      const cause = extracted.left.error;
      const code = errorCode(cause);
      const error = new OpenCodeBinaryError({
        message: `Failed to extract the OpenCode archive: ${describeCause(cause)}`,
        cause,
        reason: classifyFileError(cause),
      });
      const retryable = (code !== undefined && LOCKED_CODES.has(code)) || mentionsVirus(cause);
      if (!retryable) return yield* Effect.fail(error);
      return { _tag: "Retry", error } satisfies ExtractAttempt;
    }

    const sizes = extracted.right instanceof Map ? extracted.right : undefined;
    const expectedSize = sizes?.get(spec.executableName) as number | undefined;
    const problem = yield* inspectExecutable(context, executable, expectedSize);
    if (problem !== null) return yield* incomplete(problem);

    // Security software can quarantine the file a moment after it's written.
    yield* sleep(context.delays.verifyMs);
    const later = yield* inspectExecutable(context, executable, expectedSize);
    if (later !== null) return yield* incomplete(later.replace(/ is missing$/, " vanished"));

    return { _tag: "Extracted", installDirectory } satisfies ExtractAttempt;
  });
}

function extractWithRetry(
  context: InstallContext,
  archivePath: string,
  temporaryDirectory: string,
): Effect.Effect<string, OpenCodeBinaryError> {
  const attempt = (
    number: number,
    previous: readonly OpenCodeBinaryError[],
  ): Effect.Effect<string, OpenCodeBinaryError> =>
    Effect.gen(function* () {
      const result = yield* extractOnce(
        context,
        archivePath,
        join(temporaryDirectory, `install-${number}`),
      );
      if (result._tag === "Extracted") return result.installDirectory;

      const errors = [...previous, result.error];
      if (number >= EXTRACT_ATTEMPTS) {
        // ENOSPC and low free space fail at once as disk_full, so they never reach here.
        const reason = errors.some((error) => error.reason === "blocked_by_security")
          ? "blocked_by_security"
          : classifyFileError(result.error.cause, true);
        return yield* fail(
          `${result.error.message} (${number} attempts)`,
          result.error.cause ?? errors,
          reason,
        );
      }
      yield* Effect.logWarning(
        `[opencode] Extract attempt ${number} failed, retrying: ${result.error.message}`,
      );
      // Drop the failed attempt so a partial 180 MB executable doesn't eat the free space
      // the next attempt needs.
      yield* Effect.ignore(
        Effect.tryPromise(() =>
          rm(join(temporaryDirectory, `install-${number}`), { recursive: true, force: true }),
        ),
      );
      yield* sleep(context.delays.extractRetryMs[number - 1] ?? 0);
      return yield* attempt(number + 1, errors);
    });
  return attempt(1, []);
}

/**
 * Windows can lock a new directory while security software scans it. `findPublished` looks for a
 * copy another running BloxBot installed in the meantime, since a rename can't replace that.
 */
function publishWithRetry(
  context: InstallContext,
  installDirectory: string,
  versionDirectory: string,
  findPublished: Effect.Effect<OpenCodeBinary | null>,
): Effect.Effect<void, OpenCodeBinaryError> {
  const retryDelays = context.delays.renameRetryMs;
  const attempt = (number: number): Effect.Effect<void, OpenCodeBinaryError> =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        Effect.tryPromise(() => context.fileSystem.rename(installDirectory, versionDirectory)),
      );
      if (Either.isRight(result)) return;
      if (yield* findPublished) return;

      const cause = result.left.error;
      const code = errorCode(cause);
      const retryable = code !== undefined && RENAME_RETRY_CODES.has(code);
      if (!retryable || number > retryDelays.length) {
        const suffix = retryable ? ` (${number} attempts)` : "";
        return yield* fail(
          `Failed to publish the OpenCode installation: ${describeCause(cause)}${suffix}`,
          cause,
          classifyFileError(cause, retryable),
        );
      }
      // Nothing is in flight during this wait, so quitting doesn't have to sit through it.
      yield* Effect.interruptible(sleep(retryDelays[number - 1] ?? 0));
      return yield* attempt(number + 1);
    });
  return attempt(1);
}

/**
 * Deletes a broken copy of a version before the new one takes its place. Windows refuses while
 * antivirus is still reading a file in it, which made v0.14.0 fail with EPERM, so this waits it out
 * the same way publishing does.
 */
function replaceWithRetry(
  context: InstallContext,
  versionDirectory: string,
  findPublished: Effect.Effect<OpenCodeBinary | null>,
): Effect.Effect<void, OpenCodeBinaryError> {
  const retryDelays = context.delays.renameRetryMs;
  const attempt = (number: number): Effect.Effect<void, OpenCodeBinaryError> =>
    Effect.gen(function* () {
      // Another BloxBot may have put a working copy there while this one waited, and it stays.
      if (number > 1 && (yield* findPublished)) return;
      const result = yield* Effect.either(
        Effect.tryPromise(() => context.fileSystem.remove(versionDirectory)),
      );
      if (Either.isRight(result)) return;
      if (yield* findPublished) return;

      const cause = result.left.error;
      const code = errorCode(cause);
      const retryable = code !== undefined && RENAME_RETRY_CODES.has(code);
      if (!retryable || number > retryDelays.length) {
        const suffix = retryable ? ` (${number} attempts)` : "";
        return yield* fail(
          `Failed to replace the cached OpenCode version: ${describeCause(cause)}${suffix}`,
          cause,
          classifyFileError(cause, retryable),
        );
      }
      yield* Effect.interruptible(sleep(retryDelays[number - 1] ?? 0));
      return yield* attempt(number + 1);
    });
  return attempt(1);
}

function installRelease(
  context: InstallContext,
  release: CompatibleRelease,
): Effect.Effect<OpenCodeBinary, OpenCodeBinaryError> {
  const { platformDirectory, platform, arch, spec, downloadFetch, reportProgress } = context;
  const versionDirectory = join(platformDirectory, release.version.value);
  // Named by its checksum, so it can only ever be picked up for this exact file. The version is
  // there so clearing up after an install can tell a newer release's download from an older one.
  const savedDownload = join(
    context.partialDirectory,
    `${spec.archiveName}.${release.version.value}.${release.archiveSha256}.partial`,
  );

  return Effect.gen(function* () {
    yield* requireFreeSpace(context);
    // Setup can stop after the download, as when antivirus blocks unpacking. A complete, verified
    // copy from then means trying again doesn't have to fetch it.
    const savedArchive = yield* Effect.promise(() => readFile(savedDownload).catch(() => null));
    const alreadyVerified =
      savedArchive &&
      createHash("sha256").update(savedArchive).digest("hex") === release.archiveSha256
        ? savedArchive
        : null;
    const { archiveBuffer, response } = alreadyVerified
      ? { archiveBuffer: alreadyVerified, response: new Response() }
      : yield* tryNetwork("OpenCode download failed", DOWNLOAD_STALL_TIMEOUT_MS, (signal) =>
          downloadWithResume(
            release.asset.browser_download_url,
            downloadFetch,
            signal,
            savedDownload,
            context.delays.resumeMs,
            reportProgress,
          ),
        );
    if (!response.ok) {
      return yield* fail(
        `OpenCode download failed with ${describeHttpFailure(response)}`,
        undefined,
        "network",
      );
    }
    if (archiveBuffer === undefined) {
      return yield* fail("OpenCode returned an unreadable download", undefined, "network");
    }

    const archive = Buffer.from(archiveBuffer);
    reportProgress?.({ phase: "verifying" });
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== release.archiveSha256) {
      yield* Effect.promise(() => rm(savedDownload, { force: true }).catch(() => {}));
      return yield* fail(
        "The downloaded OpenCode archive failed SHA-256 verification",
        undefined,
        "network",
      );
    }
    if (!alreadyVerified) yield* Effect.promise(() => saveDownload(savedDownload, archive));

    reportProgress?.({ phase: "installing" });
    // Made only now: a slow download can outlast the hour after which another launch sweeps
    // the folder away, and nothing goes in it until the download is done.
    const installed = yield* Effect.acquireUseRelease(
      tryPromise("Failed to create a temporary OpenCode directory", () =>
        mkdtemp(join(platformDirectory, ".download-")),
      ),
      // Node filesystem and archive APIs do not accept AbortSignal. Mask this
      // publish phase so interruption cannot race cleanup against in-flight writes.
      (temporaryDirectory) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const archivePath = join(temporaryDirectory, spec.archiveName);
            yield* tryPromise("Failed to write the OpenCode archive", () =>
              writeFile(archivePath, archive),
            );
            const installDirectory = yield* extractWithRetry(
              context,
              archivePath,
              temporaryDirectory,
            );

            const executable = join(installDirectory, spec.executableName);
            if (platform !== "win32") {
              yield* tryPromise("Failed to make the OpenCode binary executable", () =>
                chmod(executable, 0o755),
              );
            }

            const metadata: CacheMetadata = {
              schemaVersion: 1,
              version: release.version.value,
              platform,
              arch,
              assetName: spec.archiveName,
              archiveSha256,
              binarySha256: yield* sha256File(executable),
            };
            yield* tryPromise("Failed to write OpenCode cache metadata", () =>
              writeFile(join(installDirectory, "metadata.json"), JSON.stringify(metadata, null, 2)),
            );
            const findPublished = readValidCachedBinary(
              versionDirectory,
              platform,
              arch,
              spec,
              release,
            );
            // Another running BloxBot may have just installed this version, and may be using it.
            const published = yield* findPublished;
            if (published) return published;

            yield* replaceWithRetry(context, versionDirectory, findPublished);
            yield* publishWithRetry(context, installDirectory, versionDirectory, findPublished);
            return {
              executable: join(versionDirectory, spec.executableName),
              version: release.version.value,
            };
          }),
        ),
      (temporaryDirectory) =>
        tryPromise("Failed to remove the temporary OpenCode directory", () =>
          rm(temporaryDirectory, { recursive: true, force: true }),
        ).pipe(Effect.catchAll((error) => Effect.logWarning(error.message, error.cause))),
    );
    yield* Effect.promise(() => rm(savedDownload, { force: true }).catch(() => {}));
    // Only now, since a failed lookup can land here on an older release while a newer one's
    // download is still worth resuming.
    yield* Effect.promise(() =>
      removeOtherSavedDownloads(savedDownload, spec.archiveName, release.version),
    );
    return installed;
  });
}

function pruneCache(platformDirectory: string, inUse: readonly string[] = [], keep = 2) {
  return Effect.gen(function* () {
    const entries = yield* tryPromise("Failed to inspect the OpenCode cache", () =>
      readdir(platformDirectory, { withFileTypes: true }),
    );
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseVersion(entry.name))
      .filter((version): version is Version => version !== null)
      .sort((left, right) => compareVersions(right, left));

    yield* Effect.all(
      versions.slice(keep).filter((version) => !inUse.includes(version.value)).map((version) =>
        tryPromise(`Failed to prune cached OpenCode v${version.value}`, () =>
          rm(join(platformDirectory, version.value), { recursive: true, force: true }),
        ),
      ),
      { concurrency: 4, discard: true },
    );
  });
}

/**
 * Security software and a full disk explain a failure whichever attempt hit them. Otherwise
 * the pinned install, the last thing tried, says why setup stopped.
 */
function combinedFailureReason(
  updateError: OpenCodeBinaryError,
  pinnedError: OpenCodeBinaryError,
): OpenCodeInstallFailureReason {
  const reasons = [updateError.reason, pinnedError.reason];
  // A full disk also makes files go missing, so it wins over security software.
  if (reasons.includes("disk_full")) return "disk_full";
  if (reasons.includes("blocked_by_security")) return "blocked_by_security";
  return pinnedError.reason ?? updateError.reason ?? "other";
}

/**
 * Another copy to try when this one passed its checks but wouldn't run. With none, there's nothing
 * more to try here, and the failure stands.
 */
export function findOpenCodeFallback(
  options: Pick<OpenCodeBinaryOptions, "cacheDirectory" | "platform" | "arch">,
  failedVersion: string,
): Effect.Effect<OpenCodeBinary | null> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return getOpenCodeAssetSpec(platform, arch).pipe(
    Effect.flatMap((spec) =>
      findNewestCachedBinary(
        join(options.cacheDirectory, `${platform}-${arch}`),
        platform,
        arch,
        spec,
        [failedVersion],
      ),
    ),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

/** Stops choosing a version that wouldn't run here when an older one did. */
export function distrustOpenCodeVersion(
  options: Pick<OpenCodeBinaryOptions, "cacheDirectory" | "platform" | "arch">,
  version: string,
): Effect.Effect<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return Effect.promise(() =>
    updateCacheNotes(join(options.cacheDirectory, `${platform}-${arch}`), (notes) => ({
      ...notes,
      distrusted: [...new Set([...notes.distrusted, version])],
    })),
  );
}

export function ensureOpenCodeBinary(
  options: OpenCodeBinaryOptions,
): Effect.Effect<OpenCodeBinary, OpenCodeBinaryError> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchFn = options.fetch ?? fetch;
  const extractArchive = options.extractArchive ?? defaultExtractArchive;
  const platformDirectory = join(options.cacheDirectory, `${platform}-${arch}`);
  const pinnedRelease = options.pinnedRelease ?? PINNED_OPENCODE_RELEASE;

  return Effect.gen(function* () {
    yield* Effect.sync(() => options.onStartupProgress?.({ phase: "checking" }));
    const spec = yield* getOpenCodeAssetSpec(platform, arch);
    yield* tryPromise("Failed to create the OpenCode cache directory", () =>
      mkdir(platformDirectory, { recursive: true }),
    );

    const context: InstallContext = {
      platformDirectory,
      partialDirectory: join(options.cacheDirectory, "partial"),
      platform,
      arch,
      spec,
      // Only downloads, never the release lookup: the expected SHA-256 has to come from the app
      // or from Node's stricter TLS, so software that intercepts HTTPS can't vouch for a binary.
      downloadFetch: withCertificateFallback(fetchFn, options.fetchWithSystemCertificates),
      extractArchive,
      fileSystem: { ...DEFAULT_FILE_SYSTEM, ...options.fileSystem },
      delays: { ...DEFAULT_DELAYS, ...options.delays },
      reportProgress: options.onStartupProgress,
    };
    const install = (release: CompatibleRelease) =>
      installRelease(context, release).pipe(
        Effect.tap(() =>
          pruneCache(platformDirectory).pipe(
            Effect.catchAll((error) => Effect.logWarning(error.message, error.cause)),
          ),
        ),
      );

    // With a working copy nobody should wait on anything. A newer one comes down in the background,
    // saying nothing to the startup screen, and is used from the next launch.
    yield* Effect.promise(() => sweepAbandonedInstalls(platformDirectory));
    const notes = yield* Effect.promise(() => readCacheNotes(platformDirectory));
    const working = yield* findNewestCachedBinary(platformDirectory, platform, arch, spec);
    if (working) {
      // One that has already refused to run here is passed over for the newest that hasn't.
      yield* findCompatibleRelease(fetchFn, spec.archiveName, notes.distrusted).pipe(
        Effect.tap((release) =>
          Effect.promise(() =>
            updateCacheNotes(platformDirectory, (notes) => ({
              ...notes,
              latest: release.version.value,
            })),
          ),
        ),
        Effect.flatMap((release) =>
          readValidCachedBinary(
            join(platformDirectory, release.version.value),
            platform,
            arch,
            spec,
            release,
          ).pipe(
            Effect.flatMap((cached) =>
              cached
                ? Effect.void
                : Effect.gen(function* () {
                    // If the working copy won't start, startup falls back to this one, which may
                    // be looking it up while this install runs. Pruning mustn't take it away.
                    const fallback = yield* findNewestCachedBinary(
                      platformDirectory,
                      platform,
                      arch,
                      spec,
                      [working.version],
                    );
                    yield* installRelease({ ...context, reportProgress: undefined }, release);
                    yield* pruneCache(
                      platformDirectory,
                      fallback ? [working.version, fallback.version] : [working.version],
                    );
                  }),
            ),
          ),
        ),
        Effect.catchAll((error) =>
          Effect.logWarning(`[opencode] Background update failed: ${error.message}`, error.cause),
        ),
        Effect.forkDaemon,
      );
      return working;
    }

    // Newer releases come from the API. When it fails (rate limit, timeout, DNS), the pinned release
    // keeps BloxBot working. One that has already refused to run here is passed over for the newest
    // that hasn't.
    const updated = yield* Effect.either(
      findCompatibleRelease(fetchFn, spec.archiveName, notes.distrusted).pipe(
        Effect.flatMap(install),
      ),
    );
    if (Either.isRight(updated)) return updated.right;
    const updateError = updated.left;

    // The connection gave out partway, or security software blocked it. The pinned file comes from
    // the same place and would be blocked the same way, so trying it only starts again from nothing.
    const blocked = updateError.reason === "blocked_by_security";
    if (blocked || updateError.message.startsWith("OpenCode download failed: ")) {
      const reason = blocked ? "blocked_by_security" : "network";
      return yield* fail(
        `Unable to download a verified OpenCode ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x release and no cached copy is available. ` +
          `Release check: ${updateError.message} (reason: ${reason})`,
        updateError,
        reason,
      );
    }

    const pinned = pinnedCompatibleRelease(pinnedRelease, platform, arch, spec);
    const pinnedResult = yield* Effect.either(
      !pinned
        ? fail(`No pinned OpenCode release for ${platform}/${arch}`)
        : notes.distrusted.includes(pinned.version.value)
          ? fail("it has already failed to run on this computer")
          : install(pinned),
    );
    if (Either.isRight(pinnedResult)) {
      yield* Effect.logWarning(
        `[opencode] Update check failed; installed pinned v${pinnedResult.right.version}: ${updateError.message}`,
        updateError.cause,
      );
      return pinnedResult.right;
    }

    const reason = combinedFailureReason(updateError, pinnedResult.left);
    return yield* fail(
      `Unable to download a verified OpenCode ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x release and no cached copy is available. ` +
        `Release check: ${updateError.message}. ` +
        `Pinned v${pinnedRelease.version}: ${pinnedResult.left.message} (reason: ${reason})`,
      [updateError, pinnedResult.left],
      reason,
    );
  });
}

function pinnedCompatibleRelease(
  pinned: PinnedOpenCodeRelease,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
): CompatibleRelease | null {
  const asset = pinned.assets[`${platform}-${arch}`];
  const version = parseVersion(pinned.version);
  if (
    !asset ||
    !version ||
    asset.assetName !== spec.archiveName ||
    !asset.url.startsWith(OPEN_CODE_DOWNLOAD_PREFIX) ||
    !/^[a-f\d]{64}$/.test(asset.sha256)
  ) {
    return null;
  }
  return {
    version,
    asset: {
      name: asset.assetName,
      browser_download_url: asset.url,
      digest: `sha256:${asset.sha256}`,
    },
    archiveSha256: asset.sha256,
  };
}
