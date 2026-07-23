import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Logger, LogLevel } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureOpenCodeBinary,
  type GitHubRelease,
  getOpenCodeAssetSpec,
  selectCompatibleRelease,
} from "../../electron/services/OpenCodeBinary";
import type { OpenCodeStartupProgress } from "../types/desktop";

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
    expect(Effect.runSync(getOpenCodeAssetSpec("darwin", "arm64")).archiveName).toBe(
      "opencode-darwin-arm64.zip",
    );
    expect(Effect.runSync(getOpenCodeAssetSpec("darwin", "x64")).archiveName).toBe(
      "opencode-darwin-x64.zip",
    );
    expect(Effect.runSync(getOpenCodeAssetSpec("win32", "x64")).executableName).toBe(
      "opencode.exe",
    );
    expect(Effect.runSync(getOpenCodeAssetSpec("linux", "x64")).format).toBe("tar.gz");
    expect(Effect.runSync(Effect.either(getOpenCodeAssetSpec("win32", "arm64")))).toMatchObject({
      _tag: "Left",
      left: { _tag: "OpenCodeBinaryError", message: expect.stringContaining("win32/arm64") },
    });
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
    const startupProgress: OpenCodeStartupProgress[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockResolvedValueOnce(
        new Response(archive, { headers: { "content-length": String(archive.byteLength) } }),
      );
    const extractArchive = vi.fn(async (_archivePath: string, destination: string) => {
      await writeFile(join(destination, "opencode"), "runtime binary");
    });

    const installed = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive,
        onStartupProgress: (progress) => startupProgress.push(progress),
      }),
    );

    expect(installed.version).toBe("1.4.2");
    expect(installed.executable).toBe(join(cacheDirectory, "darwin-arm64", "1.4.2", "opencode"));
    await expect(readFile(installed.executable, "utf8")).resolves.toBe("runtime binary");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(startupProgress[0]).toEqual({ phase: "checking" });
    expect(startupProgress).toContainEqual({
      phase: "downloading",
      downloadedBytes: archive.byteLength,
      totalBytes: archive.byteLength,
      bytesPerSecond: expect.any(Number),
    });
    expect(startupProgress.slice(-2)).toEqual([{ phase: "verifying" }, { phase: "installing" }]);

    const cached = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch: vi.fn().mockRejectedValue(new Error("offline")),
        extractArchive,
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

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

    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "linux",
          arch: "x64",
          fetch,
          extractArchive: vi.fn(),
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "OpenCodeBinaryError",
        message: expect.stringContaining("no cached copy is available"),
      },
    });
  });

  it("fails closed when only a new major release exists", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-windows-x64.zip";

    const result = await Effect.runPromise(
      Effect.either(
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
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "OpenCodeBinaryError",
        message: expect.stringContaining("no cached copy is available"),
      },
    });
  });

  it("aborts an in-flight download and cleans its temporary directory", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-darwin-arm64.zip";
    const releases = [release("v1.4.2", assetName, `sha256:${"a".repeat(64)}`)];
    let downloadSignal: AbortSignal | undefined;
    let markDownloadStarted: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        downloadSignal = init?.signal ?? undefined;
        markDownloadStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          downloadSignal?.addEventListener("abort", () => reject(downloadSignal?.reason), {
            once: true,
          });
        });
      });
    const fiber = Effect.runFork(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: vi.fn(),
      }),
    );

    await downloadStarted;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(downloadSignal?.aborted).toBe(true);
    const entries = await readdir(join(cacheDirectory, "darwin-arm64"));
    expect(entries.some((entry) => entry.startsWith(".download-"))).toBe(false);
  });

  it("waits for non-cancellable extraction before cleaning up on interruption", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("verified archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const assetName = "opencode-darwin-arm64.zip";
    const releases = [release("v1.4.2", assetName, `sha256:${digest}`)];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockResolvedValueOnce(new Response(archive));
    let markExtractionStarted: (() => void) | undefined;
    const extractionStarted = new Promise<void>((resolve) => {
      markExtractionStarted = resolve;
    });
    let finishExtraction: (() => Promise<void>) | undefined;
    const extractArchive = vi.fn(
      (_archivePath: string, destination: string) =>
        new Promise<void>((resolve) => {
          finishExtraction = async () => {
            await writeFile(join(destination, "opencode"), "runtime binary");
            resolve();
          };
          markExtractionStarted?.();
        }),
    );
    const fiber = Effect.runFork(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive,
      }),
    );

    await extractionStarted;
    const interruption = Effect.runPromise(Fiber.interrupt(fiber));
    const entriesDuringExtraction = await readdir(join(cacheDirectory, "darwin-arm64"));
    expect(entriesDuringExtraction.some((entry) => entry.startsWith(".download-"))).toBe(true);

    expect(finishExtraction).toBeTypeOf("function");
    await finishExtraction?.();
    await interruption;

    const entriesAfterInterruption = await readdir(join(cacheDirectory, "darwin-arm64"));
    expect(entriesAfterInterruption.some((entry) => entry.startsWith(".download-"))).toBe(false);
  });
});
