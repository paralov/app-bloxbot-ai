import { createHash } from "node:crypto";
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
import { join } from "node:path";

import { Data, Effect, Either, Schema } from "effect";
import extractZip from "extract-zip";
import { x as extractTar } from "tar";

import type { OpenCodeStartupProgress } from "../../src/types/desktop";
import { PINNED_OPENCODE_RELEASE, type PinnedOpenCodeRelease } from "./openCodePinnedRelease";

const OPEN_CODE_API = "https://api.github.com/repos/anomalyco/opencode/releases";
const OPEN_CODE_DOWNLOAD_PREFIX = "https://github.com/anomalyco/opencode/releases/download/";
const SUPPORTED_MAJOR = 1;
const RELEASES_PER_PAGE = 100;
const LOOKUP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The Windows archive unpacks to a ~180 MB executable; leave room for the archive and a margin. */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;
const EXTRACT_ATTEMPTS = 3;
const RENAME_ATTEMPTS = 3;
/** Error codes Windows returns while antivirus software scans or locks a new file. */
const LOCKED_CODES = new Set(["EPERM", "EBUSY", "EACCES", "UNKNOWN"]);
const DENIED_CODES = new Set(["EPERM", "EACCES"]);
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const VIRUS_PATTERN = /virus|potentially unwanted/i;

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

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
  /** Before the 2nd and 3rd publish (rename) attempts. */
  renameRetryMs: readonly number[];
}

const DEFAULT_DELAYS: OpenCodeInstallDelays = {
  extractRetryMs: [1_000, 3_000],
  verifyMs: 500,
  renameRetryMs: [250, 1_000],
};

async function defaultFreeBytes(path: string): Promise<number | null> {
  // statfs is missing from older Node releases and can fail on some network drives.
  if (typeof statfs !== "function") return null;
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

const DEFAULT_FILE_SYSTEM: OpenCodeInstallFileSystem = {
  rename,
  stat,
  freeBytes: defaultFreeBytes,
};

export interface OpenCodeBinaryOptions {
  cacheDirectory: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: Fetch;
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

async function readDownload(
  response: Response,
  signal: AbortSignal,
  reportProgress?: StartupProgressReporter,
): Promise<Buffer | undefined> {
  if (!response.body) return undefined;

  const totalBytes = contentLength(response);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const startedAt = Date.now();
  let downloadedBytes = 0;
  let lastReportAt = startedAt;

  const report = (now: number) => {
    const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
    reportProgress?.({
      phase: "downloading",
      downloadedBytes,
      totalBytes,
      bytesPerSecond: Math.round(downloadedBytes / elapsedSeconds),
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

      chunks.push(value);
      downloadedBytes += value.byteLength;
      const now = Date.now();
      if (now - lastReportAt >= 100) {
        report(now);
        lastReportAt = now;
      }
    }
    report(Date.now());
    return Buffer.concat(chunks, downloadedBytes);
  } finally {
    signal.removeEventListener("abort", abortRead);
    reader.releaseLock();
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
  return version.major === SUPPORTED_MAJOR ? version : null;
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
  if (platform === "darwin" && arch === "x64") {
    return Effect.succeed({
      archiveName: "opencode-darwin-x64.zip",
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
): CompatibleRelease | null {
  const candidates = releases.flatMap((release): CompatibleRelease[] => {
    if (release.draft || release.prerelease) return [];
    const version = parseVersion(release.tag_name);
    if (!version) return [];

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
function findCompatibleRelease(fetchFn: Fetch, archiveName: string) {
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

    const release = selectCompatibleRelease(releases, archiveName);
    if (release) return release;
    return yield* fail(
      `No stable OpenCode ${SUPPORTED_MAJOR}.x.x release is available for ${archiveName}`,
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

function findNewestCachedBinary(
  platformDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
): Effect.Effect<OpenCodeBinary | null, never> {
  return Effect.gen(function* () {
    const entries = yield* tryPromise("Failed to inspect the OpenCode cache", () =>
      readdir(platformDirectory, { withFileTypes: true }),
    );
    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseVersion(entry.name))
      .filter((version): version is Version => version !== null)
      .sort((left, right) => compareVersions(right, left));

    for (const version of versions) {
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
  platform: NodeJS.Platform;
  arch: string;
  spec: AssetSpec;
  fetchFn: Fetch;
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

/** Windows can briefly lock a new directory while security software scans it. */
function publishWithRetry(
  context: InstallContext,
  installDirectory: string,
  versionDirectory: string,
): Effect.Effect<void, OpenCodeBinaryError> {
  const attempt = (number: number): Effect.Effect<void, OpenCodeBinaryError> =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        Effect.tryPromise(() => context.fileSystem.rename(installDirectory, versionDirectory)),
      );
      if (Either.isRight(result)) return;

      const cause = result.left.error;
      const code = errorCode(cause);
      const retryable = code !== undefined && RENAME_RETRY_CODES.has(code);
      if (!retryable || number >= RENAME_ATTEMPTS) {
        const suffix = retryable ? ` (${number} attempts)` : "";
        return yield* fail(
          `Failed to publish the OpenCode installation: ${describeCause(cause)}${suffix}`,
          cause,
          classifyFileError(cause, retryable),
        );
      }
      yield* sleep(context.delays.renameRetryMs[number - 1] ?? 0);
      return yield* attempt(number + 1);
    });
  return attempt(1);
}

function installRelease(
  context: InstallContext,
  release: CompatibleRelease,
): Effect.Effect<OpenCodeBinary, OpenCodeBinaryError> {
  const { platformDirectory, platform, arch, spec, fetchFn, reportProgress } = context;
  return Effect.acquireUseRelease(
    tryPromise(
      "Failed to create a temporary OpenCode directory",
      () => mkdtemp(join(platformDirectory, ".download-")),
    ),
    (temporaryDirectory) => {
      const archivePath = join(temporaryDirectory, spec.archiveName);
      const versionDirectory = join(platformDirectory, release.version.value);

      return Effect.gen(function* () {
        yield* requireFreeSpace(context);
        const { archiveBuffer, response } = yield* tryNetwork(
          "OpenCode download failed",
          DOWNLOAD_TIMEOUT_MS,
          async (signal) => {
            const downloadSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            ]);
            const response = await fetchFn(release.asset.browser_download_url, {
              headers: { "User-Agent": "BloxBot" },
              signal: downloadSignal,
            });
            return {
              archiveBuffer: response.ok
                ? await readDownload(response, downloadSignal, reportProgress)
                : undefined,
              response,
            };
          },
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
          return yield* fail(
            "The downloaded OpenCode archive failed SHA-256 verification",
            undefined,
            "network",
          );
        }

        // Node filesystem and archive APIs do not accept AbortSignal. Mask this
        // publish phase so interruption cannot race cleanup against in-flight writes.
        reportProgress?.({ phase: "installing" });
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
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
              writeFile(
                join(installDirectory, "metadata.json"),
                JSON.stringify(metadata, null, 2),
              ),
            );
            yield* tryPromise("Failed to replace the cached OpenCode version", () =>
              rm(versionDirectory, { recursive: true, force: true }),
            );
            yield* publishWithRetry(context, installDirectory, versionDirectory);
            return {
              executable: join(versionDirectory, spec.executableName),
              version: release.version.value,
            };
          }),
        );
      });
    },
    (temporaryDirectory) =>
      tryPromise("Failed to remove the temporary OpenCode directory", () =>
        rm(temporaryDirectory, { recursive: true, force: true }),
      ).pipe(Effect.catchAll((error) => Effect.logWarning(error.message, error.cause))),
  );
}

function pruneCache(platformDirectory: string, keep = 2) {
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
      versions.slice(keep).map((version) =>
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
      platform,
      arch,
      spec,
      fetchFn,
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

    // Newer releases come from the API. When it fails (rate limit, timeout, DNS), a cached
    // copy or the pinned release keeps BloxBot working.
    const updated = yield* Effect.either(
      findCompatibleRelease(fetchFn, spec.archiveName).pipe(
        Effect.flatMap((release) =>
          readValidCachedBinary(
            join(platformDirectory, release.version.value),
            platform,
            arch,
            spec,
            release,
          ).pipe(Effect.flatMap((cached) => (cached ? Effect.succeed(cached) : install(release)))),
        ),
      ),
    );
    if (Either.isRight(updated)) return updated.right;
    const updateError = updated.left;

    const cached = yield* findNewestCachedBinary(platformDirectory, platform, arch, spec);
    if (cached) {
      yield* Effect.logWarning(
        `[opencode] Update check failed; using cached v${cached.version}: ${updateError.message}`,
        updateError.cause,
      );
      return cached;
    }

    const pinned = pinnedCompatibleRelease(pinnedRelease, platform, arch, spec);
    const pinnedResult = yield* Effect.either(
      pinned ? install(pinned) : fail(`No pinned OpenCode release for ${platform}/${arch}`),
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
      `Unable to download a verified OpenCode ${SUPPORTED_MAJOR}.x.x release and no cached copy is available. ` +
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
