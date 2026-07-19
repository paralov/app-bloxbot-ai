import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import extractZip from "extract-zip";
import { x as extractTar } from "tar";

const OPEN_CODE_API = "https://api.github.com/repos/anomalyco/opencode/releases";
const OPEN_CODE_DOWNLOAD_PREFIX = "https://github.com/anomalyco/opencode/releases/download/";
const SUPPORTED_MAJOR = 1;
const RELEASES_PER_PAGE = 100;
const LOOKUP_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

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

interface CacheMetadata {
  schemaVersion: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
}

export interface OpenCodeBinary {
  executable: string;
  version: string;
}

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

export function getOpenCodeAssetSpec(platform: NodeJS.Platform, arch: string): AssetSpec {
  if (platform === "darwin" && arch === "arm64") {
    return {
      archiveName: "opencode-darwin-arm64.zip",
      executableName: "opencode",
      format: "zip",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      archiveName: "opencode-darwin-x64.zip",
      executableName: "opencode",
      format: "zip",
    };
  }
  if (platform === "win32" && arch === "x64") {
    return {
      archiveName: "opencode-windows-x64.zip",
      executableName: "opencode.exe",
      format: "zip",
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      archiveName: "opencode-linux-x64.tar.gz",
      executableName: "opencode",
      format: "tar.gz",
    };
  }
  throw new Error(`OpenCode does not provide a supported binary for ${platform}/${arch}`);
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

async function findCompatibleRelease(fetchFn: Fetch, archiveName: string): Promise<CompatibleRelease> {
  for (let page = 1; page <= 10; page++) {
    const response = await fetchFn(
      `${OPEN_CODE_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "BloxBot",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed with HTTP ${response.status}`);
    }

    const releases = (await response.json()) as GitHubRelease[];
    if (!Array.isArray(releases)) throw new Error("GitHub returned an invalid release list");
    const release = selectCompatibleRelease(releases, archiveName);
    if (release) return release;
    if (releases.length < RELEASES_PER_PAGE) break;
  }

  throw new Error(`No stable OpenCode ${SUPPORTED_MAJOR}.x.x release is available for ${archiveName}`);
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isCacheMetadata(value: unknown): value is CacheMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<CacheMetadata>;
  return (
    metadata.schemaVersion === 1 &&
    typeof metadata.version === "string" &&
    typeof metadata.platform === "string" &&
    typeof metadata.arch === "string" &&
    typeof metadata.assetName === "string" &&
    typeof metadata.archiveSha256 === "string" &&
    typeof metadata.binarySha256 === "string"
  );
}

async function readValidCachedBinary(
  versionDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
  expected?: CompatibleRelease,
): Promise<OpenCodeBinary | null> {
  try {
    const metadata = JSON.parse(
      await readFile(join(versionDirectory, "metadata.json"), "utf8"),
    ) as unknown;
    if (!isCacheMetadata(metadata) || !parseVersion(metadata.version)) return null;
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
    if (!(await stat(executable)).isFile()) return null;
    if ((await sha256File(executable)) !== metadata.binarySha256) return null;
    if (platform !== "win32") await chmod(executable, 0o755);
    return { executable, version: metadata.version };
  } catch {
    return null;
  }
}

async function findNewestCachedBinary(
  platformDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
): Promise<OpenCodeBinary | null> {
  let entries;
  try {
    entries = await readdir(platformDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseVersion(entry.name))
    .filter((version): version is Version => version !== null)
    .sort((left, right) => compareVersions(right, left));

  for (const version of versions) {
    const cached = await readValidCachedBinary(
      join(platformDirectory, version.value),
      platform,
      arch,
      spec,
    );
    if (cached) return cached;
  }
  return null;
}

async function defaultExtractArchive(
  archivePath: string,
  destination: string,
  format: AssetSpec["format"],
): Promise<void> {
  if (format === "zip") {
    await extractZip(archivePath, { dir: destination });
    return;
  }
  await extractTar({ file: archivePath, cwd: destination, strict: true });
}

async function installRelease(
  platformDirectory: string,
  platform: NodeJS.Platform,
  arch: string,
  spec: AssetSpec,
  release: CompatibleRelease,
  fetchFn: Fetch,
  extractArchive: ExtractArchive,
): Promise<OpenCodeBinary> {
  const temporaryDirectory = join(
    platformDirectory,
    `.download-${process.pid}-${Date.now()}`,
  );
  const installDirectory = join(temporaryDirectory, "install");
  const archivePath = join(temporaryDirectory, spec.archiveName);
  const versionDirectory = join(platformDirectory, release.version.value);

  await mkdir(installDirectory, { recursive: true });
  try {
    const response = await fetchFn(release.asset.browser_download_url, {
      headers: { "User-Agent": "BloxBot" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`OpenCode download failed with HTTP ${response.status}`);

    const archive = Buffer.from(await response.arrayBuffer());
    const archiveSha256 = createHash("sha256").update(archive).digest("hex");
    if (archiveSha256 !== release.archiveSha256) {
      throw new Error("The downloaded OpenCode archive failed SHA-256 verification");
    }
    await writeFile(archivePath, archive);
    await extractArchive(archivePath, installDirectory, spec.format);

    const executable = join(installDirectory, spec.executableName);
    if (!(await stat(executable)).isFile()) {
      throw new Error(`The OpenCode archive did not contain ${spec.executableName}`);
    }
    if (platform !== "win32") await chmod(executable, 0o755);

    const metadata: CacheMetadata = {
      schemaVersion: 1,
      version: release.version.value,
      platform,
      arch,
      assetName: spec.archiveName,
      archiveSha256,
      binarySha256: await sha256File(executable),
    };
    await writeFile(join(installDirectory, "metadata.json"), JSON.stringify(metadata, null, 2));

    await rm(versionDirectory, { recursive: true, force: true });
    await rename(installDirectory, versionDirectory);
    return { executable: join(versionDirectory, spec.executableName), version: release.version.value };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function pruneCache(platformDirectory: string, keep = 2): Promise<void> {
  const entries = await readdir(platformDirectory, { withFileTypes: true });
  const versions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => parseVersion(entry.name))
    .filter((version): version is Version => version !== null)
    .sort((left, right) => compareVersions(right, left));

  await Promise.all(
    versions.slice(keep).map((version) =>
      rm(join(platformDirectory, version.value), { recursive: true, force: true }),
    ),
  );
}

export async function ensureOpenCodeBinary(
  options: OpenCodeBinaryOptions,
): Promise<OpenCodeBinary> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const fetchFn = options.fetch ?? fetch;
  const extractArchive = options.extractArchive ?? defaultExtractArchive;
  const spec = getOpenCodeAssetSpec(platform, arch);
  const platformDirectory = join(options.cacheDirectory, `${platform}-${arch}`);
  await mkdir(platformDirectory, { recursive: true });

  try {
    const release = await findCompatibleRelease(fetchFn, spec.archiveName);
    const versionDirectory = join(platformDirectory, release.version.value);
    const cached = await readValidCachedBinary(
      versionDirectory,
      platform,
      arch,
      spec,
      release,
    );
    const binary =
      cached ??
      (await installRelease(
        platformDirectory,
        platform,
        arch,
        spec,
        release,
        fetchFn,
        extractArchive,
      ));
    await pruneCache(platformDirectory);
    return binary;
  } catch (cause) {
    const cached = await findNewestCachedBinary(platformDirectory, platform, arch, spec);
    if (cached) {
      console.warn(`[opencode] Update check failed; using cached v${cached.version}`, cause);
      return cached;
    }
    throw new Error(
      `Unable to download a verified OpenCode ${SUPPORTED_MAJOR}.x.x release and no cached copy is available`,
      { cause },
    );
  }
}
