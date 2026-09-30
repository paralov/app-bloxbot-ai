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
import type { PinnedOpenCodeRelease } from "../../electron/services/openCodePinnedRelease";
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

function pinnedFor(key: string, assetName: string, archive: Buffer): PinnedOpenCodeRelease {
  return {
    version: "1.2.3",
    assets: {
      [key]: {
        assetName,
        url: `https://github.com/anomalyco/opencode/releases/download/v1.2.3/${assetName}`,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    },
  };
}

function rateLimited() {
  return new Response("rate limited", {
    status: 403,
    headers: { "x-ratelimit-remaining": "0" },
  });
}

function writeExecutable(name: string) {
  return vi.fn(async (_archivePath: string, destination: string) => {
    await writeFile(join(destination, name), "runtime binary");
  });
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

    const offlineFetch = vi.fn().mockRejectedValue(new Error("offline"));
    const cached = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch: offlineFetch,
        extractArchive,
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

    expect(cached).toEqual(installed);
    expect(extractArchive).toHaveBeenCalledTimes(1);
    expect(offlineFetch).toHaveBeenCalledTimes(1);
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

  it("never installs a new major release and falls back to the pinned 1.x.x release", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-windows-x64.zip";
    const archive = Buffer.from("pinned windows archive");
    const pinnedRelease = pinnedFor("win32-x64", assetName, archive);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([release("v2.0.0", assetName, `sha256:${"c".repeat(64)}`)]),
      )
      .mockResolvedValueOnce(new Response(archive));

    const installed = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch,
        extractArchive: writeExecutable("opencode.exe"),
        pinnedRelease,
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

    expect(installed.version).toBe("1.2.3");
    expect(fetch).toHaveBeenLastCalledWith(
      pinnedRelease.assets["win32-x64"]?.url,
      expect.anything(),
    );
  });

  it("installs the pinned release when GitHub's release API returns 403", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-windows-x64.zip";
    const archive = Buffer.from("pinned windows archive");
    const pinnedRelease = pinnedFor("win32-x64", assetName, archive);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(archive));

    const installed = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch,
        extractArchive: writeExecutable("opencode.exe"),
        pinnedRelease,
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

    expect(installed).toEqual({
      executable: join(cacheDirectory, "win32-x64", "1.2.3", "opencode.exe"),
      version: "1.2.3",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("api.github.com");
    expect(fetch.mock.calls[1]?.[0]).toBe(pinnedRelease.assets["win32-x64"]?.url);
  });

  it("installs the pinned release when GitHub's release API times out", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-linux-x64.tar.gz";
    const archive = Buffer.from("pinned linux archive");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValueOnce(new Response(archive));

    const installed = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "linux",
        arch: "x64",
        fetch,
        extractArchive: writeExecutable("opencode"),
        pinnedRelease: pinnedFor("linux-x64", assetName, archive),
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

    expect(installed.version).toBe("1.2.3");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a pinned download whose SHA-256 does not match and says why", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const extractArchive = vi.fn();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response("tampered archive"));

    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "win32",
          arch: "x64",
          fetch,
          extractArchive,
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "OpenCodeBinaryError",
        message: expect.stringMatching(
          /no cached copy is available.*HTTP 403, x-ratelimit-remaining 0.*Pinned v\d+\.\d+\.\d+: The downloaded OpenCode archive failed SHA-256 verification/,
        ),
      },
    });
    expect(extractArchive).not.toHaveBeenCalled();
    expect(await readdir(join(cacheDirectory, "win32-x64"))).toEqual([]);
  });

  it("puts timeout and DNS errors in the final message", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const dnsFailure = new TypeError("fetch failed", {
      cause: new Error("getaddrinfo ENOTFOUND github.com"),
    });
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockRejectedValueOnce(dnsFailure);

    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({ cacheDirectory, platform: "darwin", arch: "x64", fetch }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        message: expect.stringMatching(
          /GitHub release lookup failed: timed out after 15 seconds.*OpenCode download failed: fetch failed \(getaddrinfo ENOTFOUND github\.com\)/,
        ),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("prefers a newer release from the API over the cached copy", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-darwin-arm64.zip";
    const oldArchive = Buffer.from("old archive");
    const newArchive = Buffer.from("new archive");
    const sha = (archive: Buffer) => createHash("sha256").update(archive).digest("hex");
    const extractArchive = writeExecutable("opencode");

    await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch: vi
          .fn()
          .mockResolvedValueOnce(
            Response.json([release("v1.4.2", assetName, `sha256:${sha(oldArchive)}`)]),
          )
          .mockResolvedValueOnce(new Response(oldArchive)),
        extractArchive,
      }),
    );

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          release("v1.4.2", assetName, `sha256:${sha(oldArchive)}`),
          release("v1.5.0", assetName, `sha256:${sha(newArchive)}`),
        ]),
      )
      .mockResolvedValueOnce(new Response(newArchive));
    const updated = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive,
      }),
    );

    expect(updated.version).toBe("1.5.0");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toContain("/v1.5.0/");
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
