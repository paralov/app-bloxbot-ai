import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as realRename,
  stat as realStat,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Logger, LogLevel } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOWNLOAD_STALL_TIMEOUT_MS,
  describeCause,
  distrustOpenCodeVersion,
  ensureOpenCodeBinary,
  findOpenCodeFallback,
  type GitHubRelease,
  MIN_FREE_BYTES,
  type OpenCodeBinaryOptions,
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
    version: "2.2.3",
    assets: {
      [key]: {
        assetName,
        url: `https://github.com/anomalyco/opencode/releases/download/v2.2.3/${assetName}`,
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

/**
 * Runs an install under a fake clock, moving time on until it settles, so minutes of waiting take
 * milliseconds. Only timers and the date are faked, because the install does real file I/O.
 */
async function runInVirtualTime<A, E>(effect: Effect.Effect<A, E>) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const startedAt = Date.now();
  let elapsedMs: number | undefined;
  const running = Effect.runPromise(
    Effect.either(effect).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
  ).finally(() => {
    elapsedMs = Date.now() - startedAt;
  });
  while (elapsedMs === undefined) {
    await vi.advanceTimersByTimeAsync(1_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { result: await running, elapsedMs };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OpenCode binary releases", () => {
  it("selects the newest verified stable 2.2.x release and rejects other lines", () => {
    const assetName = "opencode-darwin-arm64.zip";
    const digest = `sha256:${"a".repeat(64)}`;
    const selected = selectCompatibleRelease(
      [
        release("v3.0.0", assetName, digest),
        release("v2.3.0", assetName, digest),
        release("v1.19.5", assetName, digest),
        release("v2.2.12-beta.1", assetName, digest),
        release("v2.2.11", assetName, digest, { prerelease: true }),
        release("v2.2.10", assetName, null),
        release("v2.2.7", assetName, digest),
        release("v2.2.9", assetName, digest),
      ],
      assetName,
    );

    expect(selected?.version.value).toBe("2.2.9");
    expect(selected?.archiveSha256).toBe("a".repeat(64));
  });

  it("downloads, verifies, installs, and reuses a cached binary when offline", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("verified archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const assetName = "opencode-darwin-arm64.zip";
    const releases = [release("v2.2.2", assetName, `sha256:${digest}`)];
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

    expect(installed.version).toBe("2.2.2");
    expect(installed.executable).toBe(join(cacheDirectory, "darwin-arm64", "2.2.2", "opencode"));
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
        Response.json([release("v2.2.7", assetName, `sha256:${"b".repeat(64)}`)]),
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
          delays: { resumeMs: [] },
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

  it("never installs a new major release and falls back to the pinned 2.2.x release", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-windows-x64.zip";
    const archive = Buffer.from("pinned windows archive");
    const pinnedRelease = pinnedFor("win32-x64", assetName, archive);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([release("v3.0.0", assetName, `sha256:${"c".repeat(64)}`)]),
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

    expect(installed.version).toBe("2.2.3");
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
      executable: join(cacheDirectory, "win32-x64", "2.2.3", "opencode.exe"),
      version: "2.2.3",
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

    expect(installed.version).toBe("2.2.3");
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

  it("aborts an in-flight download and cleans its temporary directory", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const assetName = "opencode-darwin-arm64.zip";
    const releases = [release("v2.2.2", assetName, `sha256:${"a".repeat(64)}`)];
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
    const releases = [release("v2.2.2", assetName, `sha256:${digest}`)];
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

describe("OpenCode installs that Windows blocks", () => {
  const NO_DELAYS = { extractRetryMs: [0, 0], verifyMs: 0, renameRetryMs: [0, 0] };
  const PLENTY_OF_SPACE = async () => 10 * 1024 ** 3;
  const EXE = "opencode.exe";

  function errno(code: string, message: string) {
    return Object.assign(new Error(message), { code });
  }

  const eperm = () =>
    errno("EPERM", "EPERM: operation not permitted, open 'C:\\cache\\install\\opencode.exe'");

  async function installOnWindows(
    options: Pick<OpenCodeBinaryOptions, "extractArchive" | "fileSystem">,
  ) {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("pinned windows archive");
    const fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("api.github.com") ? rateLimited() : new Response(archive),
    );
    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "win32",
          arch: "x64",
          fetch,
          pinnedRelease: pinnedFor("win32-x64", "opencode-windows-x64.zip", archive),
          delays: NO_DELAYS,
          extractArchive: options.extractArchive,
          fileSystem: { freeBytes: PLENTY_OF_SPACE, ...options.fileSystem },
        }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
      ),
    );
    return { cacheDirectory, fetch, result };
  }

  it("puts the errno code and message of a failed step in the error", async () => {
    const extractArchive = vi.fn(async () => {
      throw new Error("invalid central directory file header signature");
    });
    const { result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "other",
        message: expect.stringContaining(
          "Failed to extract the OpenCode archive: invalid central directory file header signature (reason: other)",
        ),
      },
    });
    expect(extractArchive).toHaveBeenCalledTimes(1);
    expect(describeCause(errno("EBUSY", "resource busy or locked"))).toBe(
      "EBUSY: resource busy or locked",
    );
    expect(describeCause(eperm())).toBe(
      "EPERM: operation not permitted, open 'C:\\cache\\install\\opencode.exe'",
    );
  });

  it("retries an extract that antivirus locks, in a fresh folder each time", async () => {
    const destinations: string[] = [];
    const extractArchive = vi.fn(async (_archive: string, destination: string) => {
      destinations.push(destination);
      if (destinations.length < 3) throw eperm();
      await writeFile(join(destination, EXE), "runtime binary");
    });
    const { cacheDirectory, result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({
      _tag: "Right",
      right: { executable: join(cacheDirectory, "win32-x64", "2.2.3", EXE) },
    });
    expect(extractArchive).toHaveBeenCalledTimes(3);
    expect(new Set(destinations).size).toBe(3);
  });

  it("blames security software when the extract keeps failing with EPERM", async () => {
    const extractArchive = vi.fn(async () => {
      throw eperm();
    });
    const { cacheDirectory, result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "blocked_by_security",
        message: expect.stringMatching(
          /Pinned v2\.2\.3: Failed to extract the OpenCode archive: EPERM: operation not permitted, open .*opencode\.exe' \(3 attempts\) \(reason: blocked_by_security\)$/,
        ),
      },
    });
    expect(extractArchive).toHaveBeenCalledTimes(3);
    expect(await readdir(join(cacheDirectory, "win32-x64"))).toEqual([]);
  });

  it("removes a failed attempt's files before retrying", async () => {
    const destinations: string[] = [];
    const leftovers: string[][] = [];
    const extractArchive = vi.fn(async (_archive: string, destination: string) => {
      // What earlier attempts left behind in the temporary folder.
      leftovers.push(
        destinations.flatMap((previous) => (existsSync(join(previous, EXE)) ? [previous] : [])),
      );
      destinations.push(destination);
      await writeFile(join(destination, EXE), "partial");
      if (destinations.length < 3) throw eperm();
    });
    const { result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({ _tag: "Right" });
    expect(leftovers).toEqual([[], [], []]);
  });

  it("retries when the new executable is briefly locked while it's inspected", async () => {
    const extractArchive = writeExecutable(EXE);
    const stat = vi
      .fn(realStat)
      .mockRejectedValueOnce(errno("EBUSY", "EBUSY: resource busy or locked"));
    const { result } = await installOnWindows({ extractArchive, fileSystem: { stat } });

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    expect(extractArchive).toHaveBeenCalledTimes(2);
  });

  it("blames security software when the extract stays busy", async () => {
    const extractArchive = vi.fn(async () => {
      throw errno("EBUSY", "EBUSY: resource busy or locked");
    });
    const { result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({ _tag: "Left", left: { reason: "blocked_by_security" } });
    expect(extractArchive).toHaveBeenCalledTimes(3);
  });

  it("retries and blames security software when the error mentions a virus", async () => {
    const extractArchive = vi.fn(async () => {
      throw errno(
        "UNKNOWN",
        "UNKNOWN: Operation did not complete successfully because the file contains a virus or potentially unwanted software.",
      );
    });
    const { result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({ _tag: "Left", left: { reason: "blocked_by_security" } });
    expect(extractArchive).toHaveBeenCalledTimes(3);
  });

  it("retries when the executable vanishes right after extraction", async () => {
    const extractArchive = writeExecutable(EXE);
    const stat = vi
      .fn(realStat)
      .mockImplementationOnce(realStat)
      .mockRejectedValueOnce(errno("ENOENT", "ENOENT: no such file or directory"));
    const { result } = await installOnWindows({ extractArchive, fileSystem: { stat } });

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    expect(extractArchive).toHaveBeenCalledTimes(2);
  });

  it("blames security software when the executable keeps vanishing", async () => {
    const extractArchive = writeExecutable(EXE);
    let calls = 0;
    const stat = vi.fn(async (path: string) => {
      calls += 1;
      if (calls % 2 === 0) throw errno("ENOENT", "ENOENT: no such file or directory");
      return realStat(path);
    });
    const { result } = await installOnWindows({ extractArchive, fileSystem: { stat } });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "blocked_by_security",
        message: expect.stringContaining(
          "opencode.exe vanished after extraction, likely removed by security software (3 attempts)",
        ),
      },
    });
    expect(extractArchive).toHaveBeenCalledTimes(3);
  });

  it("treats a missing or short executable as quarantined", async () => {
    const missing = vi.fn(async () => {});
    const { result: missingResult } = await installOnWindows({ extractArchive: missing });
    expect(missingResult).toMatchObject({
      _tag: "Left",
      left: {
        reason: "blocked_by_security",
        message: expect.stringContaining("opencode.exe is missing after extraction"),
      },
    });
    expect(missing).toHaveBeenCalledTimes(3);

    const expectedSize = 180 * 1024 ** 2;
    const short = vi.fn(async (_archive: string, destination: string) => {
      await writeFile(join(destination, EXE), "runtime binary");
      return new Map([[EXE, expectedSize]]);
    });
    const { result: shortResult } = await installOnWindows({ extractArchive: short });
    expect(shortResult).toMatchObject({
      _tag: "Left",
      left: {
        reason: "blocked_by_security",
        message: expect.stringContaining(`opencode.exe is 14 of ${expectedSize} bytes`),
      },
    });
    expect(short).toHaveBeenCalledTimes(3);
  });

  it("blames a full disk, not antivirus, when the drive fills during extraction", async () => {
    const extractArchive = vi.fn(async (_archive: string, destination: string) => {
      await writeFile(join(destination, EXE), "runtime binary");
      return new Map([[EXE, 180 * 1024 ** 2]]);
    });
    const freeBytes = vi
      .fn(PLENTY_OF_SPACE)
      .mockImplementationOnce(PLENTY_OF_SPACE)
      .mockImplementation(async () => 40 * 1024 ** 2);
    const { result } = await installOnWindows({ extractArchive, fileSystem: { freeBytes } });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "disk_full",
        message: expect.stringContaining(
          "Failed to extract the OpenCode archive: opencode.exe is 14 of 188743680 bytes after extraction with 40 MB free, 500 MB needed (reason: disk_full)",
        ),
      },
    });
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("reports a full disk without retrying", async () => {
    const extractArchive = vi.fn(async () => {
      throw errno("ENOSPC", "ENOSPC: no space left on device, write");
    });
    const { result } = await installOnWindows({ extractArchive });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "disk_full",
        message: expect.stringContaining(
          "Failed to extract the OpenCode archive: ENOSPC: no space left on device, write (reason: disk_full)",
        ),
      },
    });
    expect(extractArchive).toHaveBeenCalledTimes(1);
  });

  it("stops before downloading when the drive has too little free space", async () => {
    const extractArchive = vi.fn();
    const freeBytes = vi.fn(async () => 120 * 1024 ** 2);
    const { fetch, result } = await installOnWindows({
      extractArchive,
      fileSystem: { freeBytes },
    });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "disk_full",
        message: expect.stringContaining(
          "Not enough free disk space to install OpenCode: 120 MB free, 500 MB needed (reason: disk_full)",
        ),
      },
    });
    expect(MIN_FREE_BYTES).toBe(500 * 1024 ** 2);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(extractArchive).not.toHaveBeenCalled();
  });

  it("installs anyway when free space can't be read", async () => {
    const { result } = await installOnWindows({
      extractArchive: writeExecutable(EXE),
      fileSystem: {
        freeBytes: async () => {
          throw errno("ENOSYS", "ENOSYS: function not implemented, statfs");
        },
      },
    });
    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
  });

  it("retries publishing while Windows locks the new folder", async () => {
    const rename = vi
      .fn(realRename)
      .mockRejectedValueOnce(errno("EBUSY", "EBUSY: resource busy or locked, rename"))
      .mockRejectedValueOnce(errno("EPERM", "EPERM: operation not permitted, rename"));
    const { cacheDirectory, result } = await installOnWindows({
      extractArchive: writeExecutable(EXE),
      fileSystem: { rename },
    });

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    expect(rename).toHaveBeenCalledTimes(3);
    await expect(readFile(join(cacheDirectory, "win32-x64", "2.2.3", EXE), "utf8")).resolves.toBe(
      "runtime binary",
    );
  });

  it("gives up publishing after three locked attempts and blames security software", async () => {
    const rename = vi.fn(async () => {
      throw errno("EPERM", "EPERM: operation not permitted, rename");
    });
    const { result } = await installOnWindows({
      extractArchive: writeExecutable(EXE),
      fileSystem: { rename },
    });

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "blocked_by_security",
        message: expect.stringContaining(
          "Failed to publish the OpenCode installation: EPERM: operation not permitted, rename (3 attempts)",
        ),
      },
    });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("keeps retrying a publish that antivirus holds for 20 seconds", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("pinned windows archive");
    let firstAttemptAt: number | undefined;
    const rename = vi.fn(async (from: string, to: string) => {
      firstAttemptAt ??= Date.now();
      if (Date.now() - firstAttemptAt < 20_000) {
        throw errno("EPERM", "EPERM: operation not permitted, rename");
      }
      await realRename(from, to);
    });

    const { result } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch: async (url) =>
          url.includes("api.github.com") ? rateLimited() : new Response(archive),
        pinnedRelease: pinnedFor("win32-x64", "opencode-windows-x64.zip", archive),
        // The default publish delays are what's being tested.
        delays: { extractRetryMs: [0, 0], verifyMs: 0 },
        extractArchive: writeExecutable(EXE),
        fileSystem: { freeBytes: PLENTY_OF_SPACE, rename },
      }),
    );

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    expect(rename.mock.calls.length).toBeGreaterThan(3);
  });

  it("stops waiting between publish attempts when interrupted, and cleans up", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("pinned windows archive");
    let markRenameFailed: (() => void) | undefined;
    const renameFailed = new Promise<void>((resolve) => {
      markRenameFailed = resolve;
    });
    const rename = vi.fn(async () => {
      markRenameFailed?.();
      throw errno("EPERM", "EPERM: operation not permitted, rename");
    });
    const fiber = Effect.runFork(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch: async (url) =>
          url.includes("api.github.com") ? rateLimited() : new Response(archive),
        pinnedRelease: pinnedFor("win32-x64", "opencode-windows-x64.zip", archive),
        // Far longer than the test may run, so finishing at all shows the wait was cut short.
        delays: { extractRetryMs: [0, 0], verifyMs: 0, renameRetryMs: [3_600_000] },
        extractArchive: writeExecutable(EXE),
        fileSystem: { freeBytes: PLENTY_OF_SPACE, rename },
      }),
    );

    await renameFailed;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(rename).toHaveBeenCalledTimes(1);
    const entries = await readdir(join(cacheDirectory, "win32-x64"));
    expect(entries.some((entry) => entry.startsWith(".download-"))).toBe(false);
  });

  it("uses the copy another BloxBot published while this one's rename was failing", async () => {
    // Moving the folder and then failing leaves what the other install would have: a valid copy.
    const rename = vi.fn(async (from: string, to: string) => {
      await realRename(from, to);
      throw errno("EPERM", "EPERM: operation not permitted, rename");
    });
    const { cacheDirectory, result } = await installOnWindows({
      extractArchive: writeExecutable(EXE),
      fileSystem: { rename },
    });

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    expect(rename).toHaveBeenCalledTimes(1);
    await expect(readFile(join(cacheDirectory, "win32-x64", "2.2.3", EXE), "utf8")).resolves.toBe(
      "runtime binary",
    );
  });

  it("leaves a copy alone when another BloxBot published it during this install", async () => {
    const first = await installOnWindows({ extractArchive: writeExecutable(EXE) });
    expect(first.result._tag).toBe("Right");
    const published = join(first.cacheDirectory, "win32-x64", "2.2.3");
    const saved = join(await makeTemporaryDirectory(), "2.2.3");
    await cp(published, saved, { recursive: true });
    await rm(published, { recursive: true });

    const archive = Buffer.from("pinned windows archive");
    const rename = vi.fn(realRename);
    const result = await Effect.runPromise(
      ensureOpenCodeBinary({
        cacheDirectory: first.cacheDirectory,
        platform: "win32",
        arch: "x64",
        fetch: async (url) =>
          url.includes("api.github.com") ? rateLimited() : new Response(archive),
        pinnedRelease: pinnedFor("win32-x64", "opencode-windows-x64.zip", archive),
        delays: NO_DELAYS,
        extractArchive: async (_archivePath, destination) => {
          await writeFile(join(destination, EXE), "runtime binary");
          await cp(saved, published, { recursive: true });
        },
        fileSystem: { freeBytes: PLENTY_OF_SPACE, rename },
      }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
    );

    expect(result.executable).toBe(join(published, EXE));
    expect(rename).not.toHaveBeenCalled();
  });

  it("labels a failure where both downloads fail as a network problem", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "win32",
          arch: "x64",
          fetch,
          fileSystem: { freeBytes: PLENTY_OF_SPACE },
          delays: { resumeMs: [] },
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: { reason: "network", message: expect.stringContaining("(reason: network)") },
    });
  });
});

describe("OpenCode downloads on a poor connection", () => {
  const ASSET_NAME = "opencode-darwin-arm64.zip";

  /** A body that sends one chunk each `intervalMs`, then ends. */
  function slowBody(chunks: readonly Uint8Array[], intervalMs: number) {
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        const sendFrom = (index: number) => {
          setTimeout(() => {
            if (cancelled) return;
            const chunk = chunks[index];
            if (chunk) controller.enqueue(chunk);
            if (index + 1 < chunks.length) sendFrom(index + 1);
            else controller.close();
          }, intervalMs);
        };
        sendFrom(0);
      },
    });
  }

  /** A body that sends `chunk`, then a few empty chunks, and then nothing, without ever ending. */
  function stalledBody(chunk: Uint8Array) {
    let cancelled = false;
    return new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(chunk);
        for (const delayMs of [20_000, 40_000]) {
          setTimeout(() => {
            if (!cancelled) controller.enqueue(new Uint8Array(0));
          }, delayMs);
        }
      },
    });
  }

  it("finishes a download that takes far longer than 120 seconds but keeps moving", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const chunks = Array.from({ length: 5 }, (_, index) => Buffer.alloc(1024, index));
    const archive = Buffer.concat(chunks);
    const digest = createHash("sha256").update(archive).digest("hex");
    const releases = [release("v2.2.2", ASSET_NAME, `sha256:${digest}`)];
    const startupProgress: OpenCodeStartupProgress[] = [];
    const intervalMs = DOWNLOAD_STALL_TIMEOUT_MS - 1_000;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockImplementationOnce(
        async () =>
          new Response(slowBody(chunks, intervalMs), {
            headers: { "content-length": String(archive.byteLength) },
          }),
      );

    const { result, elapsedMs } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: writeExecutable("opencode"),
        onStartupProgress: (progress) => startupProgress.push(progress),
        delays: { verifyMs: 0 },
      }),
    );

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
    expect(elapsedMs).toBeGreaterThan(120_000);
    // Only the release lookup and one download, with no fallback to the pinned release.
    expect(fetch).toHaveBeenCalledTimes(2);

    const downloading = startupProgress.filter((progress) => progress.phase === "downloading");
    expect(downloading.map((progress) => progress.downloadedBytes)).toEqual(
      expect.arrayContaining([chunks[0]?.byteLength, archive.byteLength]),
    );
    expect(downloading.at(-1)).toMatchObject({
      downloadedBytes: archive.byteLength,
      totalBytes: archive.byteLength,
    });
    expect(downloading.at(-1)?.bytesPerSecond).toBeGreaterThan(0);
  });

  describe("when a connection drops partway", () => {
    const first = Buffer.alloc(1024, 1);
    const rest = Buffer.alloc(1024, 2);
    const archive = Buffer.concat([first, rest]);
    const digest = createHash("sha256").update(archive).digest("hex");
    const releases = [release("v2.2.2", ASSET_NAME, `sha256:${digest}`)];

    const install = async (fetch: ReturnType<typeof vi.fn>) =>
      runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory: await makeTemporaryDirectory(),
          platform: "darwin",
          arch: "arm64",
          fetch,
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }),
      );
    const rangeOf = (call: unknown[]) =>
      (call[1] as RequestInit).headers as Record<string, string | undefined>;

    it("carries on from where it stopped, and still checks the whole file", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(releases))
        .mockResolvedValueOnce(new Response(stalledBody(first)))
        .mockResolvedValueOnce(
          new Response(rest, {
            status: 206,
            headers: { "content-range": `bytes ${first.byteLength}-2047/2048` },
          }),
        );

      const { result } = await install(fetch);

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(rangeOf(fetch.mock.calls[1] as unknown[]).Range).toBeUndefined();
      expect(rangeOf(fetch.mock.calls[2] as unknown[]).Range).toBe(`bytes=${first.byteLength}-`);
    });

    it("takes the whole file from a server that won't resume", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(releases))
        .mockResolvedValueOnce(new Response(stalledBody(first)))
        .mockResolvedValueOnce(new Response(archive));

      const { result } = await install(fetch);

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
    });

    it("asks for the whole file again when a server sends the wrong part", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(releases))
        .mockResolvedValueOnce(new Response(stalledBody(first)))
        .mockResolvedValueOnce(
          new Response(rest, { status: 206, headers: { "content-range": "bytes 5-1028/2048" } }),
        )
        .mockResolvedValueOnce(new Response(archive));

      const { result } = await install(fetch);

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
      expect(rangeOf(fetch.mock.calls[3] as unknown[]).Range).toBeUndefined();
    });

    it("carries on from what an earlier attempt saved, after every retry ran out", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      const fail = vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) return Response.json(releases);
        if (fail.mock.calls.length === 2) return new Response(stalledBody(first));
        throw new TypeError("fetch failed");
      });
      const stalled = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: fail,
          extractArchive: writeExecutable("opencode"),
          pinnedRelease: pinnedFor("darwin-arm64", ASSET_NAME, Buffer.from("other")),
          delays: { verifyMs: 0 },
        }),
      );
      expect(stalled.result).toMatchObject({ _tag: "Left" });

      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(releases))
        .mockResolvedValueOnce(
          new Response(rest, {
            status: 206,
            headers: { "content-range": `bytes ${first.byteLength}-2047/2048` },
          }),
        );
      const { result } = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch,
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }),
      );

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
      expect(rangeOf(fetch.mock.calls[1] as unknown[]).Range).toBe(`bytes=${first.byteLength}-`);
    });

    it("starts over when what was saved is past the end of the file", async () => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json(releases))
        .mockResolvedValueOnce(new Response(stalledBody(first)))
        .mockResolvedValueOnce(new Response(null, { status: 416 }))
        .mockResolvedValueOnce(new Response(archive));

      const { result } = await install(fetch);

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
    });

    it("waits between tries, and counts only tries that got nothing more", async () => {
      let attempt = 0;
      const attemptsAt: number[] = [];
      const pieces = 6;
      const fetch = vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) return Response.json(releases);
        attemptsAt.push(Date.now());
        attempt += 1;
        // Every try but the last gets a little further, more times than the limit would allow.
        if (attempt < pieces) {
          const piece = archive.subarray(attempt - 1, attempt);
          let sent = false;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent) controller.error(new TypeError("connection reset"));
              else controller.enqueue(piece);
              sent = true;
            },
          });
          return attempt === 1
            ? new Response(stream)
            : new Response(stream, {
                status: 206,
                headers: { "content-range": `bytes ${attempt - 1}-2047/2048` },
              });
        }
        return new Response(archive.subarray(attempt - 1), {
          status: 206,
          headers: { "content-range": `bytes ${attempt - 1}-2047/2048` },
        });
      });

      const { result } = await install(fetch);

      expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
      expect(attempt).toBe(pieces);
      expect((attemptsAt[1] as number) - (attemptsAt[0] as number)).toBeGreaterThanOrEqual(5_000);
    });

    it("doesn't start over on the pinned file when the connection is what gave out", async () => {
      const fetch = vi.fn(async (url: string) => {
        if (url.includes("api.github.com")) return Response.json(releases);
        return new Response(stalledBody(first));
      });
      const { result } = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory: await makeTemporaryDirectory(),
          platform: "darwin",
          arch: "arm64",
          fetch,
          extractArchive: writeExecutable("opencode"),
          pinnedRelease: pinnedFor("darwin-arm64", "pinned.zip", Buffer.from("other")),
          delays: { verifyMs: 0 },
        }),
      );

      expect(result).toMatchObject({
        _tag: "Left",
        left: { reason: "network", message: expect.stringContaining("stalled, no data") },
      });
      expect(fetch.mock.calls.some(([url]) => String(url).includes("pinned.zip"))).toBe(false);
    });

    it("doesn't fetch again after unpacking was blocked, and doesn't try the pinned file", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      const blocked = Object.assign(new Error("Operation did not complete: virus detected"), {
        code: "EPERM",
      });
      const options = {
        cacheDirectory,
        platform: "win32" as const,
        arch: "x64",
        delays: { verifyMs: 0, extractRetryMs: [] },
      };
      const asset = "opencode-windows-x64.zip";
      const windowsArchive = [release("v2.2.2", asset, `sha256:${digest}`)];
      const windowsFetch = vi.fn(async (url: string) =>
        url.includes("api.github.com") ? Response.json(windowsArchive) : new Response(archive),
      );

      const firstTry = await runInVirtualTime(
        ensureOpenCodeBinary({
          ...options,
          fetch: windowsFetch,
          extractArchive: vi.fn().mockRejectedValue(blocked),
          pinnedRelease: pinnedFor("win32-x64", asset, Buffer.from("other")),
        }),
      );
      expect(firstTry.result).toMatchObject({
        _tag: "Left",
        left: { reason: "blocked_by_security" },
      });
      expect(
        windowsFetch.mock.calls.filter(([url]) => !String(url).includes("api.github")).length,
      ).toBe(1);

      windowsFetch.mockClear();
      const secondTry = await runInVirtualTime(
        ensureOpenCodeBinary({
          ...options,
          fetch: windowsFetch,
          extractArchive: writeExecutable("opencode.exe"),
        }),
      );
      expect(secondTry.result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
      expect(
        windowsFetch.mock.calls.filter(([url]) => !String(url).includes("api.github")).length,
      ).toBe(0);
    });

    it("opens with a working copy straight away, and updates in the background", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      const older = [release("v2.2.1", ASSET_NAME, `sha256:${digest}`)];
      const first = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: vi
            .fn()
            .mockResolvedValueOnce(Response.json(older))
            .mockResolvedValueOnce(new Response(archive)),
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }),
      );
      expect(first.result).toMatchObject({ _tag: "Right", right: { version: "2.2.1" } });
      vi.useRealTimers();

      const newer = Buffer.alloc(2048, 7);
      const newerDigest = createHash("sha256").update(newer).digest("hex");
      const progress: OpenCodeStartupProgress[] = [];
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json([release("v2.2.2", ASSET_NAME, `sha256:${newerDigest}`)]),
        )
        .mockResolvedValueOnce(new Response(newer));

      const running = await Effect.runPromise(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch,
          extractArchive: writeExecutable("opencode"),
          onStartupProgress: (update) => progress.push(update),
          delays: { verifyMs: 0 },
        }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
      );

      expect(running.version).toBe("2.2.1");
      // Nothing about the background work reaches the startup screen.
      await vi.waitFor(async () => {
        const versions = await readdir(join(cacheDirectory, "darwin-arm64"));
        expect(versions).toContain("2.2.2");
      });
      expect(progress.filter((update) => update.phase === "downloading")).toEqual([]);

      const next = await Effect.runPromise(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: vi.fn().mockRejectedValue(new TypeError("offline")),
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
      );
      expect(next.version).toBe("2.2.2");
    });

    const installVersion = async (cacheDirectory: string, version: string) => {
      const { result } = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: vi
            .fn()
            .mockResolvedValueOnce(
              Response.json([release(`v${version}`, ASSET_NAME, `sha256:${digest}`)]),
            )
            .mockResolvedValueOnce(new Response(archive)),
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }),
      );
      expect(result).toMatchObject({ _tag: "Right" });
      vi.useRealTimers();
    };
    const launch = (cacheDirectory: string, fetch: unknown) =>
      Effect.runPromise(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: fetch as never,
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
      );

    /** Has a working 2.2.1, then lets 2.2.2 arrive in the background as a real install would. */
    const installTwoVersions = async (cacheDirectory: string) => {
      await installVersion(cacheDirectory, "2.2.1");
      await launch(
        cacheDirectory,
        vi
          .fn()
          .mockResolvedValueOnce(Response.json([release("v2.2.2", ASSET_NAME, `sha256:${digest}`)]))
          .mockResolvedValueOnce(new Response(archive)),
      );
      await vi.waitFor(async () => {
        expect(await readdir(join(cacheDirectory, "darwin-arm64"))).toContain("2.2.2");
      });
    };

    it("offers an older copy when one won't run, and doesn't go back to it", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      await installTwoVersions(cacheDirectory);
      const offline = vi.fn().mockRejectedValue(new TypeError("offline"));
      const options = { cacheDirectory, platform: "darwin" as const, arch: "arm64" };
      expect((await launch(cacheDirectory, offline)).version).toBe("2.2.2");

      const fallback = await Effect.runPromise(findOpenCodeFallback(options, "2.2.2"));
      expect(fallback?.version).toBe("2.2.1");

      await Effect.runPromise(distrustOpenCodeVersion(options, "2.2.2"));
      expect((await launch(cacheDirectory, offline)).version).toBe("2.2.1");
    });

    it("has nothing to offer when no other copy exists", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      await installVersion(cacheDirectory, "2.2.1");
      const options = { cacheDirectory, platform: "darwin" as const, arch: "arm64" };
      await expect(Effect.runPromise(findOpenCodeFallback(options, "2.2.1"))).resolves.toBeNull();
    });

    it("goes back from a release GitHub has withdrawn", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      await installTwoVersions(cacheDirectory);

      // GitHub's newest is now the older one, so 2.2.2 was pulled.
      await launch(
        cacheDirectory,
        vi
          .fn()
          .mockResolvedValue(Response.json([release("v2.2.1", ASSET_NAME, `sha256:${digest}`)])),
      );
      await vi.waitFor(async () => {
        const notes = await readFile(
          join(cacheDirectory, "darwin-arm64", "cache-notes.json"),
          "utf8",
        );
        expect(notes).toContain("2.2.1");
      });

      const next = await launch(
        cacheDirectory,
        vi.fn().mockRejectedValue(new TypeError("offline")),
      );
      expect(next.version).toBe("2.2.1");
    });

    it("sweeps up what a quit left behind, but not an install still running", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      await installVersion(cacheDirectory, "2.2.1");
      const platformDirectory = join(cacheDirectory, "darwin-arm64");
      const abandoned = join(platformDirectory, ".download-old");
      const recent = join(platformDirectory, ".download-new");
      await mkdir(abandoned);
      await mkdir(recent);
      const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(abandoned, longAgo, longAgo);

      await launch(cacheDirectory, vi.fn().mockRejectedValue(new TypeError("offline")));

      const left = await readdir(platformDirectory);
      expect(left).not.toContain(".download-old");
      expect(left).toContain(".download-new");
    });

    it("clears out what was saved for an older release", async () => {
      const cacheDirectory = await makeTemporaryDirectory();
      const stale = join(cacheDirectory, "partial", `${ASSET_NAME}.old.partial`);
      await mkdir(join(cacheDirectory, "partial"), { recursive: true });
      await writeFile(stale, "old bytes");

      const { result } = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch: vi
            .fn()
            .mockResolvedValueOnce(Response.json(releases))
            .mockResolvedValueOnce(new Response(archive)),
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0 },
        }),
      );

      expect(result).toMatchObject({ _tag: "Right" });
      await expect(readFile(stale)).rejects.toThrow();
    });

    it("rejects a joined file that doesn't match its checksum", async () => {
      const fetch = vi.fn(async (url: string) =>
        url.includes("api.github.com")
          ? Response.json(releases)
          : fetch.mock.calls.length === 2
            ? new Response(stalledBody(first))
            : new Response(Buffer.alloc(1024, 9), {
                status: 206,
                headers: { "content-range": `bytes ${first.byteLength}-2047/2048` },
              }),
      );

      const { result } = await runInVirtualTime(
        ensureOpenCodeBinary({
          cacheDirectory: await makeTemporaryDirectory(),
          platform: "darwin",
          arch: "arm64",
          fetch,
          extractArchive: writeExecutable("opencode"),
          pinnedRelease: pinnedFor("darwin-arm64", ASSET_NAME, Buffer.from("other")),
          delays: { verifyMs: 0 },
        }),
      );

      expect(result).toMatchObject({ _tag: "Left" });
    });
  });

  it("tries again when a connection drops before the first byte", async () => {
    const digest = createHash("sha256").update(Buffer.from("whole")).digest("hex");
    const releases = [release("v2.2.2", ASSET_NAME, `sha256:${digest}`)];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("whole"));
    const { result } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory: await makeTemporaryDirectory(),
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: writeExecutable("opencode"),
        delays: { verifyMs: 0 },
      }),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
  });

  it("keeps what arrived when the server errors on a resume, and carries on", async () => {
    const whole = Buffer.alloc(2048, 3);
    const digest = createHash("sha256").update(whole).digest("hex");
    const releases = [release("v2.2.2", ASSET_NAME, `sha256:${digest}`)];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(releases))
      .mockResolvedValueOnce(new Response(stalledBody(whole.subarray(0, 1024))))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(whole.subarray(1024), {
          status: 206,
          headers: { "content-range": "bytes 1024-2047/2048" },
        }),
      );
    const { result } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory: await makeTemporaryDirectory(),
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: writeExecutable("opencode"),
        delays: { verifyMs: 0 },
      }),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
  });

  it("aborts a download that stops sending data and says how far it got", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("never finishes");
    let abortedAfterMs: number | undefined;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("api.github.com")) return rateLimited();
      const fetchedAt = Date.now();
      init?.signal?.addEventListener("abort", () => {
        abortedAfterMs = Date.now() - fetchedAt;
      });
      return new Response(stalledBody(Buffer.alloc(1024 ** 2)));
    });

    const { result } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: vi.fn(),
        pinnedRelease: pinnedFor("darwin-arm64", ASSET_NAME, archive),
      }),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "network",
        message: expect.stringContaining(
          `OpenCode download failed: stalled, no data for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000} seconds (1.0 MB received)`,
        ),
      },
    });
    // Counted from the last real data, so the empty chunks didn't keep it alive.
    expect(abortedAfterMs).toBeGreaterThanOrEqual(DOWNLOAD_STALL_TIMEOUT_MS);
    expect(abortedAfterMs).toBeLessThan(DOWNLOAD_STALL_TIMEOUT_MS + 5_000);
    const entries = await readdir(join(cacheDirectory, "darwin-arm64"));
    expect(entries.some((entry) => entry.startsWith(".download-"))).toBe(false);
  });

  it("aborts when the server never answers", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("api.github.com")) return Promise.resolve(rateLimited());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });

    const { result } = await runInVirtualTime(
      ensureOpenCodeBinary({
        cacheDirectory,
        platform: "darwin",
        arch: "arm64",
        fetch,
        extractArchive: vi.fn(),
        pinnedRelease: pinnedFor("darwin-arm64", ASSET_NAME, Buffer.from("never sent")),
      }),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "network",
        message: expect.stringContaining("stalled, no data for 60 seconds (0.0 MB received)"),
      },
    });
  });
});

describe("OpenCode downloads refused over an unknown certificate issuer", () => {
  const ASSET_NAME = "opencode-darwin-arm64.zip";

  /** How Node's fetch rejects, checked against a real TLS server. */
  function certificateFailure(code: string) {
    return Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("unable to verify the first certificate"), { code }),
    });
  }

  function install(
    options: Pick<OpenCodeBinaryOptions, "fetch" | "fetchWithSystemCertificates" | "pinnedRelease">,
    cacheDirectory: string,
  ) {
    return Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          extractArchive: writeExecutable("opencode"),
          delays: { verifyMs: 0, resumeMs: [] },
          ...options,
        }).pipe(Logger.withMinimumLogLevel(LogLevel.None)),
      ),
    );
  }

  it.each([
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
  ])("installs the pinned release over system certificates after %s", async (code) => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("pinned archive");
    const pinnedRelease = pinnedFor("darwin-arm64", ASSET_NAME, archive);
    const fetch = vi.fn().mockRejectedValue(certificateFailure(code));
    const fetchWithSystemCertificates = vi.fn().mockResolvedValueOnce(new Response(archive));

    const result = await install(
      { fetch, fetchWithSystemCertificates, pinnedRelease },
      cacheDirectory,
    );

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.3" } });
    // The lookup supplies the expected SHA-256, so it never goes over system certificates.
    expect(fetchWithSystemCertificates).toHaveBeenCalledTimes(1);
    expect(fetchWithSystemCertificates.mock.calls[0]?.[0]).toBe(
      pinnedRelease.assets["darwin-arm64"]?.url,
    );
    // The stall limit and interruption still reach the request that replaced the failed one.
    expect(fetchWithSystemCertificates.mock.calls[0]?.[1]?.signal).toBe(
      fetch.mock.calls[1]?.[1]?.signal,
    );
  });

  it("checks a download over system certificates against the digest Node fetched", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const archive = Buffer.from("verified archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([release("v2.2.2", ASSET_NAME, `sha256:${digest}`)]))
      .mockRejectedValueOnce(certificateFailure("SELF_SIGNED_CERT_IN_CHAIN"));
    const fetchWithSystemCertificates = vi.fn().mockResolvedValueOnce(new Response(archive));

    const result = await install({ fetch, fetchWithSystemCertificates }, cacheDirectory);

    expect(result).toMatchObject({ _tag: "Right", right: { version: "2.2.2" } });
    expect(fetchWithSystemCertificates).toHaveBeenCalledTimes(1);
  });

  it("rejects an archive with the wrong SHA-256 over system certificates", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const extractArchive = vi.fn();
    const fetch = vi.fn().mockRejectedValue(certificateFailure("SELF_SIGNED_CERT_IN_CHAIN"));
    const fetchWithSystemCertificates = vi.fn(async () => new Response("tampered archive"));

    const result = await Effect.runPromise(
      Effect.either(
        ensureOpenCodeBinary({
          cacheDirectory,
          platform: "darwin",
          arch: "arm64",
          fetch,
          fetchWithSystemCertificates,
          extractArchive,
          pinnedRelease: pinnedFor("darwin-arm64", ASSET_NAME, Buffer.from("real archive")),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        message: expect.stringContaining(
          "The downloaded OpenCode archive failed SHA-256 verification",
        ),
      },
    });
    expect(fetchWithSystemCertificates).toHaveBeenCalledTimes(1);
    expect(extractArchive).not.toHaveBeenCalled();
    expect(await readdir(join(cacheDirectory, "darwin-arm64"))).toEqual([]);
  });

  it.each([
    ["an expired certificate", certificateFailure("CERT_HAS_EXPIRED")],
    ["a wrong-host certificate", certificateFailure("ERR_TLS_CERT_ALTNAME_INVALID")],
    ["a timeout", new DOMException("The operation timed out.", "TimeoutError")],
  ])("doesn't fall back after %s", async (_label, failure) => {
    const cacheDirectory = await makeTemporaryDirectory();
    const fetch = vi.fn().mockRejectedValue(failure);
    const fetchWithSystemCertificates = vi.fn();

    const result = await install({ fetch, fetchWithSystemCertificates }, cacheDirectory);

    expect(result._tag).toBe("Left");
    expect(fetchWithSystemCertificates).not.toHaveBeenCalled();
  });

  it.each([
    ["a refused connection", certificateFailure("ECONNREFUSED")],
    ["a failure with no cause", new TypeError("fetch failed")],
  ])("tries the system's network after %s, since Node doesn't know its proxy", async (_label, failure) => {
    const cacheDirectory = await makeTemporaryDirectory();
    const fetch = vi.fn().mockRejectedValue(failure);
    const fetchWithSystemCertificates = vi.fn().mockRejectedValue(failure);

    const result = await install({ fetch, fetchWithSystemCertificates }, cacheDirectory);

    expect(result._tag).toBe("Left");
    expect(fetchWithSystemCertificates).toHaveBeenCalled();
  });

  it("reports the certificate error when there is no fallback", async () => {
    const cacheDirectory = await makeTemporaryDirectory();
    const fetch = vi.fn().mockRejectedValue(certificateFailure("SELF_SIGNED_CERT_IN_CHAIN"));

    const result = await install({ fetch }, cacheDirectory);

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        reason: "network",
        message: expect.stringContaining("unable to verify the first certificate"),
      },
    });
  });
});
