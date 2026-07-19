import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureOpenCodeBinary,
  type GitHubRelease,
  getOpenCodeAssetSpec,
  selectCompatibleRelease,
} from "../../electron/services/OpenCodeBinary";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "bloxbot-opencode-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function release(
  version: string,
  assetName: string,
  digest: string | null,
  options: { draft?: boolean; prerelease?: boolean } = {},
): GitHubRelease {
  return {
    tag_name: version,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/anomalyco/opencode/releases/download/${version}/${assetName}`,
        digest,
      },
    ],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OpenCode binary releases", () => {
  it("maps every packaged platform to its official archive", () => {
    expect(getOpenCodeAssetSpec("darwin", "arm64").archiveName).toBe("opencode-darwin-arm64.zip");
    expect(getOpenCodeAssetSpec("darwin", "x64").archiveName).toBe("opencode-darwin-x64.zip");
    expect(getOpenCodeAssetSpec("win32", "x64").executableName).toBe("opencode.exe");
    expect(getOpenCodeAssetSpec("linux", "x64").format).toBe("tar.gz");
    expect(() => getOpenCodeAssetSpec("win32", "arm64")).toThrow("win32/arm64");
  });

  it("selects the newest verified stable 1.x.x release and rejects other majors", () => {
    const assetName = "opencode-darwin-arm64.zip";
    const digest = `sha256:${"a".repeat(64)}`;
    const selected = selectCompatibleRelease(
      [
        release("v2.0.0", assetName, digest),
        release("v1.12.0-beta.1", assetName, digest),
        release("v1.11.9", assetName, digest, { prerelease: true }),
        release("v1.10.3", assetName, null),
        release("v1.9.12", assetName, digest),
        release("v1.11.2", assetName, digest),
      ],
      assetName,
    );

    expect(selected?.version.value).toBe("1.11.2");
    expect(selected?.archiveSha256).toBe("a".repeat(64));
  });

  it("downloads, verifies, installs, and reuses a cached binary when offline", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("verified archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const assetName = "opencode-darwin-arm64.zip";
    const releases = [release("v1.4.2", assetName, `sha256:${digest}`)];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockResolvedValueOnce(new Response(archive));
    const extractArchive = vi.fn(async (_archivePath: string, destination: string) => {
      await writeFile(join(destination, "opencode"), "runtime binary");
    });

    const installed = await ensureOpenCodeBinary({
      cacheDirectory,
      platform: "darwin",
      arch: "arm64",
      fetch,
      extractArchive,
    });

    expect(installed.version).toBe("1.4.2");
    expect(installed.executable).toBe(join(cacheDirectory, "darwin-arm64", "1.4.2", "opencode"));
    await expect(readFile(installed.executable, "utf8")).resolves.toBe("runtime binary");
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cached = await ensureOpenCodeBinary({
      cacheDirectory,
      platform: "darwin",
      arch: "arm64",
      fetch: vi.fn().mockRejectedValue(new Error("offline")),
      extractArchive,
    });

    expect(cached).toEqual(installed);
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("does not install an archive whose digest does not match", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-linux-x64.tar.gz";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([release("v1.7.0", assetName, `sha256:${"b".repeat(64)}`)]),
      )
      .mockResolvedValueOnce(new Response("tampered archive"));

    await expect(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "linux",
        arch: "x64",
        fetch,
        extractArchive: vi.fn(),
      }),
    ).rejects.toThrow("no cached copy is available");
  });

  it("fails closed when only a new major release exists", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-windows-x64.zip";

    await expect(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch: vi
          .fn()
          .mockResolvedValue(
            Response.json([release("v2.0.0", assetName, `sha256:${"c".repeat(64)}`)]),
          ),
      }),
    ).rejects.toThrow("no cached copy is available");
  });
});
