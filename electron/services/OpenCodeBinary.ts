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
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Schema } from "effect";
import extractZip from "extract-zip";
import { x as extractTar } from "tar";

const OPEN_CODE_API = "https://api.github.com/repos/anomalyco/opencode/releases";
const OPEN_CODE_DOWNLOAD_PREFIX = "https://github.com/anomalyco/opencode/releases/download/";
const SUPPORTED_MAJOR = 1;
const RELEASES_PER_PAGE = 100;
const LOOKUP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

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

export class OpenCodeBinaryError extends Data.TaggedError("OpenCodeBinaryError")<{
  message: string;
  cause?: unknown;
}> {}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type ExtractArchive = (
  archivePath: string,
  destination: string,
  format: AssetSpec["format"],
) => Promise<void>;

export interface OpenCodeBinaryOptions {
  cacheDirectory: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: Fetch;
  extractArchive?: ExtractArchive;
}

const fail = (message: string, cause?: unknown) =>
  Effect.fail(new OpenCodeBinaryError({ message, cause }));

const tryPromise = <A>(message: string, evaluate: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new OpenCodeBinaryError({ message, cause }),
  });

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

function findCompatibleRelease(fetchFn: Fetch, archiveName: string) {
  return Effect.gen(function* () {
    for (let page = 1; page <= 10; page++) {
      const { releasesJson, response } = yield* tryPromise(
        "GitHub release lookup failed",
        async (signal) => {
          const response = await fetchFn(`${OPEN_CODE_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
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
        return yield* fail(`GitHub release lookup failed with HTTP ${response.status}`);
      }

      const releases = yield* Schema.decodeUnknown(GitHubReleasesSchema)(releasesJson).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCodeBinaryError({ message: "GitHub returned an invalid release list", cause }),
        ),
      );

      const release = selectCompatibleRelease(releases, archiveName);
      if (release) return release;
      if (releases.length < RELEASES_PER_PAGE) break;
    }

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
      resume(Effect.fail(new OpenCodeBinaryError({ message: `Failed to hash ${path}`, cause })));
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

const defaultExtractArchive: ExtractArchive = (archivePath, destination, format) =>
  format === "zip"
    ? extractZip(archivePath, { dir: destination })
    : extractTar({ file: archivePath, cwd: destination, strict: true });

function installRelease(
  platformDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
  release: CompatibleRelease,
  fetchFn: Fetch,
  extractArchive: ExtractArchive,
): Effect.Effect<OpenCodeBinary, OpenCodeBinaryError> {
  return Effect.acquireUseRelease(
    tryPromise(
      "Failed to create a temporary OpenCode directory",
      () => mkdtemp(join(platformDirectory, ".download-")),
    ),
    (temporaryDirectory) => {
      const installDirectory = join(temporaryDirectory, "install");
      const archivePath = join(temporaryDirectory, spec.archiveName);
      const versionDirectory = join(platformDirectory, release.version.value);

      return Effect.gen(function* () {
        yield* tryPromise("Failed to create the OpenCode installation directory", () =>
          mkdir(installDirectory, { recursive: true }),
        );
        const { archiveBuffer, response } = yield* tryPromise(
          "OpenCode download failed",
          async (signal) => {
            const response = await fetchFn(release.asset.browser_download_url, {
              headers: { "User-Agent": "BloxBot" },
              signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
            });
            return {
              archiveBuffer: response.ok ? await response.arrayBuffer() : undefined,
              response,
            };
          },
        );
        if (!response.ok) {
          return yield* fail(`OpenCode download failed with HTTP ${response.status}`);
        }
        if (archiveBuffer === undefined) {
          return yield* fail("OpenCode returned an unreadable download");
        }

        const archive = Buffer.from(archiveBuffer);
        const archiveSha256 = createHash("sha256").update(archive).digest("hex");
        if (archiveSha256 !== release.archiveSha256) {
          return yield* fail("The downloaded OpenCode archive failed SHA-256 verification");
        }

        // Node filesystem and archive APIs do not accept AbortSignal. Mask this
        // publish phase so interruption cannot race cleanup against in-flight writes.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* tryPromise("Failed to write the OpenCode archive", () =>
              writeFile(archivePath, archive),
            );
            yield* tryPromise("Failed to extract the OpenCode archive", () =>
              extractArchive(archivePath, installDirectory, spec.format),
            );

            const executable = join(installDirectory, spec.executableName);
            const executableStat = yield* tryPromise(
              "Failed to inspect the extracted OpenCode binary",
              () => stat(executable),
            );
            if (!executableStat.isFile()) {
              return yield* fail(`The OpenCode archive did not contain ${spec.executableName}`);
            }
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
            yield* tryPromise("Failed to publish the OpenCode installation", () =>
              rename(installDirectory, versionDirectory),
            );
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

export function ensureOpenCodeBinary(
  options: OpenCodeBinaryOptions,
): Effect.Effect<OpenCodeBinary, OpenCodeBinaryError> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchFn = options.fetch ?? fetch;
  const extractArchive = options.extractArchive ?? defaultExtractArchive;
  const platformDirectory = join(options.cacheDirectory, `${platform}-${arch}`);

  return Effect.gen(function* () {
    const spec = yield* getOpenCodeAssetSpec(platform, arch);
    yield* tryPromise("Failed to create the OpenCode cache directory", () =>
      mkdir(platformDirectory, { recursive: true }),
    );

    const onlineInstall = Effect.gen(function* () {
      const release = yield* findCompatibleRelease(fetchFn, spec.archiveName);
      const versionDirectory = join(platformDirectory, release.version.value);
      const cached = yield* readValidCachedBinary(
        versionDirectory,
        platform,
        arch,
        spec,
        release,
      );
      const binary =
        cached ??
        (yield* installRelease(
          platformDirectory,
          platform,
          arch,
          spec,
          release,
          fetchFn,
          extractArchive,
        ));
      yield* pruneCache(platformDirectory);
      return binary;
    });

    return yield* onlineInstall.pipe(
      Effect.catchAll((cause) =>
        findNewestCachedBinary(platformDirectory, platform, arch, spec).pipe(
          Effect.flatMap((cached) =>
            cached
              ? Effect.logWarning(
                  `[opencode] Update check failed; using cached v${cached.version}`,
                  cause,
                ).pipe(Effect.as(cached))
              : fail(
                  `Unable to download a verified OpenCode ${SUPPORTED_MAJOR}.x.x release and no cached copy is available`,
                  cause,
                ),
          ),
        ),
      ),
    );
  });
}
