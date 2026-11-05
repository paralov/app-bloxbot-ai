import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Data, Effect } from "effect";
import extractZip from "extract-zip";
import { x as extractTar } from "tar";
import type {
  BlenderFailureReason,
  BlenderSetupProgress,
  BlenderSetupStep,
  BlenderToolsState,
} from "../../src/types/desktop";
import uvLock from "../blender/uv.lock?raw";

const run = promisify(execFile);

/** Not Blender's default, so a copy someone already runs for themselves keeps its own. */
export const BLENDER_MCP_PORT = 9877;
const ADDON_MODULE = "bl_ext.user_default.mcp";
const PYTHON_VERSION = "3.12";
/** Blender is about 1.1 GB installed, with room for its download on top. */
export const BLENDER_MIN_FREE_BYTES = 2 * 1024 ** 3;
export const BLENDER_INSTALLED_BYTES = 1.1 * 1024 ** 3;
const DOWNLOAD_STALL_MS = 60_000;
const NO_PROGRESS_RETRIES = 3;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface PlatformFiles {
  readonly blender: PinnedFile;
  readonly uv: PinnedFile;
}

const BLENDER_VERSION = "5.2.3";
const UV_VERSION = "0.13.2";
const MCP_VERSION = "1.0.3";

const blender = (name: string, sha256: string, bytes: number): PinnedFile => ({
  name,
  url: `https://download.blender.org/release/Blender5.2/${name}`,
  sha256,
  bytes,
});
const uv = (name: string, sha256: string, bytes: number): PinnedFile => ({
  name,
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}`,
  sha256,
  bytes,
});
const lab = (name: string, sha256: string, bytes: number): PinnedFile => ({
  name,
  url: `https://projects.blender.org/lab/blender_mcp/releases/download/v${MCP_VERSION}/${name}`,
  sha256,
  bytes,
});

const PLATFORM_FILES: Readonly<Record<string, PlatformFiles>> = {
  "darwin-arm64": {
    blender: blender(
      `blender-${BLENDER_VERSION}-macos-arm64.dmg`,
      "acc05374485a272342d4b323c15ac01953e7f697da2f1bad8af9c3bf087267a4",
      346_295_881,
    ),
    uv: uv(
      "uv-aarch64-apple-darwin.tar.gz",
      "4a5d878cd0db3a57d79eec638c275e71c394e10533ae54c77b33d940866f53b7",
      14_195_937,
    ),
  },
  "win32-x64": {
    blender: blender(
      `blender-${BLENDER_VERSION}-windows-x64.zip`,
      "723f08a4401502561eb763cdeacf8745b31e5f3f154d287d3830d97cf75dc2fb",
      405_839_452,
    ),
    uv: uv(
      "uv-x86_64-pc-windows-msvc.zip",
      "9cfb447a4027550f134753253fdffbcd35b79a66dd888260bf6776891916069e",
      15_321_797,
    ),
  },
  "linux-x64": {
    blender: blender(
      `blender-${BLENDER_VERSION}-linux-x64.tar.xz`,
      "78486c018b4443efe5e75ab54c290ed8c15abafd249b862c2c9ce2530a918eec",
      385_331_224,
    ),
    uv: uv(
      "uv-x86_64-unknown-linux-gnu.tar.gz",
      "e14d48c117ec33601d6f860dda47aa5ea490d77a5a9ef770529c448fa6747d9f",
      16_654_381,
    ),
  },
};

const MCP_ADDON = lab(
  `mcp-${MCP_VERSION}.zip`,
  "a7a9da816192502e5a0a202a396444e266b47d8fc4f74ad4698048bd43040707",
  17_975,
);
const MCP_SERVER = lab(
  `blender-${MCP_VERSION}.mcpb`,
  "d6fe04dd17767f7c7fb452142f1f0e6787db575db49f3976a166142683b5b97e",
  5_500_672,
);


export class BlenderToolsError extends Data.TaggedError("BlenderToolsError")<{
  message: string;
  reason: BlenderFailureReason;
  cause?: unknown;
}> {}

class SetupCancelled extends Error {}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface BlenderToolsOptions {
  /** Everything lives here, so Remove takes all of it and nothing touches someone's own Blender. */
  root: string;
  fetch: Fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: (progress: BlenderSetupProgress) => void;
  signal?: AbortSignal;
  stallMs?: number;
  retryDelaysMs?: readonly number[];
  /** Swapped in tests, since the real ones need the real files. */
  download?: typeof downloadPinned;
  unpack?: {
    blender(archive: string, destination: string, signal?: AbortSignal): Promise<void>;
    /** Gives back where uv ended up. */
    uv(archive: string, destination: string, signal?: AbortSignal): Promise<string>;
    server(archive: string, destination: string, signal?: AbortSignal): Promise<void>;
  };
  runCommand?: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ) => Promise<void>;
  freeBytes?: (path: string) => Promise<number>;
}

const filesFor = (platform: NodeJS.Platform, arch: string) => PLATFORM_FILES[`${platform}-${arch}`];

const blenderDirectory = (root: string) => join(root, `blender-${BLENDER_VERSION}`);
const serverDirectory = (root: string) => join(root, `mcp-server-${MCP_VERSION}`);
const userResources = (root: string) => join(root, "user");
const markerPath = (root: string) => join(root, "installed.json");

function blenderExecutable(root: string, platform: NodeJS.Platform): string {
  const directory = blenderDirectory(root);
  if (platform === "darwin") return join(directory, "Blender.app", "Contents", "MacOS", "Blender");
  if (platform === "win32") {
    return join(directory, `blender-${BLENDER_VERSION}-windows-x64`, "blender.exe");
  }
  return join(directory, `blender-${BLENDER_VERSION}-linux-x64`, "blender");
}

function serverExecutable(root: string, platform: NodeJS.Platform): string {
  const venv = join(serverDirectory(root), ".venv");
  return platform === "win32"
    ? join(venv, "Scripts", "blender-mcp.exe")
    : join(venv, "bin", "blender-mcp");
}

/** Keeps uv's downloads with everything else, rather than in someone's home folder. */
function uvEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    UV_CACHE_DIR: join(root, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(root, "python"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_PROGRESS: "1",
  };
}

function blenderEnvironment(root: string): NodeJS.ProcessEnv {
  return { ...process.env, BLENDER_USER_RESOURCES: userResources(root) };
}

/** The config OpenCode needs to reach Blender, or null until setup has finished. */
export function blenderMcpServerConfig(root: string, platform: NodeJS.Platform = process.platform) {
  return {
    type: "local" as const,
    command: [serverExecutable(root, platform)],
    environment: {
      BLENDER_MCP_PORT: String(BLENDER_MCP_PORT),
      BLENDER_PATH: blenderExecutable(root, platform),
      BLENDER_USER_RESOURCES: userResources(root),
    },
  };
}

function classify(cause: unknown): BlenderFailureReason {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC") return "disk_full";
  if (code === "EPERM" || code === "EACCES" || code === "EBUSY") return "blocked";
  return "other";
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const sizeOf = (path: string) =>
  stat(path).then(
    (info) => info.size,
    () => 0,
  );

/** Ends early on Stop, so a retry waiting its turn doesn't keep setup going. */
function waitUnlessStopped(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Streams to disk, unlike the engine's download, since holding 400 MB in memory and rewriting it to
 * save progress would be slow. What arrived stays in place, so a later attempt carries on from it.
 */
export async function downloadPinned(
  file: PinnedFile,
  directory: string,
  options: Pick<BlenderToolsOptions, "fetch" | "signal" | "stallMs" | "retryDelaysMs"> & {
    onBytes?: (bytes: number) => void;
  },
): Promise<string> {
  const finished = join(directory, file.name);
  const partial = `${finished}.partial`;
  const stallMs = options.stallMs ?? DOWNLOAD_STALL_MS;
  const delays = options.retryDelaysMs ?? [5_000, 15_000, 30_000];
  await mkdir(directory, { recursive: true });

  if ((await sizeOf(finished)) === file.bytes && (await sha256Of(finished)) === file.sha256) {
    options.onBytes?.(file.bytes);
    return finished;
  }

  let failures = 0;
  for (;;) {
    if (options.signal?.aborted) throw new SetupCancelled();
    const already = await sizeOf(partial);
    options.onBytes?.(already);
    const before = already;
    const attempt = new AbortController();
    const cancelAttempt = () => attempt.abort();
    options.signal?.addEventListener("abort", cancelAttempt, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const resetStall = () => {
      clearTimeout(stall);
      stall = setTimeout(cancelAttempt, stallMs);
    };
    try {
      if (already < file.bytes) {
        resetStall();
        const response = await options.fetch(file.url, {
          signal: attempt.signal,
          headers: already > 0 ? { Range: `bytes=${already}-` } : {},
        });
        // Past the end, so what was saved can't be part of this file.
        if (response.status === 416) {
          await rm(partial, { force: true });
          continue;
        }
        if (!response.ok || !response.body) {
          throw new BlenderToolsError({
            message: `The download of ${file.name} was refused (HTTP ${response.status})`,
            reason: "network",
          });
        }
        const resuming = response.status === 206;
        let written = resuming ? already : 0;
        await pipeline(
          Readable.fromWeb(response.body as never),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              written += chunk.byteLength;
              // Checked as it arrives, so a response that never ends can't fill the disk first.
              if (written > file.bytes) {
                done(
                  new BlenderToolsError({
                    message: `${file.name} was bigger than expected`,
                    reason: "corrupt",
                  }),
                );
                return;
              }
              resetStall();
              options.onBytes?.(written);
              done(null, chunk);
            },
          }),
          createWriteStream(partial, { flags: resuming ? "a" : "w" }),
        );
      }
      clearTimeout(stall);
      if ((await sizeOf(partial)) < file.bytes) throw new Error("The connection ended early");
      if ((await sha256Of(partial)) !== file.sha256) {
        await rm(partial, { force: true });
        throw new BlenderToolsError({
          message: `${file.name} didn't match its expected contents`,
          reason: "corrupt",
        });
      }
      await rename(partial, finished);
      return finished;
    } catch (error) {
      clearTimeout(stall);
      if (options.signal?.aborted) throw new SetupCancelled();
      if (error instanceof BlenderToolsError) {
        // What came with a damaged response can't be trusted to resume from.
        if (error.reason === "corrupt") await rm(partial, { force: true });
        throw error;
      }
      const reason = classify(error);
      if (reason !== "other") {
        throw new BlenderToolsError({
          message: `Couldn't save ${file.name}`,
          reason,
          cause: error,
        });
      }
      // Any new data starts the count over, so only a connection that's really gone gives up.
      failures = (await sizeOf(partial)) > before ? 0 : failures + 1;
      if (failures > NO_PROGRESS_RETRIES) {
        throw new BlenderToolsError({
          message: `Couldn't download ${file.name}`,
          reason: "network",
          cause: error,
        });
      }
      const delay = delays[Math.min(failures, delays.length) - 1] ?? 0;
      await waitUnlessStopped(delay, options.signal);
    } finally {
      options.signal?.removeEventListener("abort", cancelAttempt);
    }
  }
}

/** Stops between files once Stop is pressed, since Blender's zip takes a while to unpack. */
function unzip(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
  return extractZip(archive, {
    dir: destination,
    onEntry: () => {
      if (signal?.aborted) throw new SetupCancelled();
    },
  });
}

/** The .dmg has to be mounted to get at it, which needs nothing more than the system's own tool. */
async function unpackDmg(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
  await mkdir(destination, { recursive: true });
  const mountPoint = await mkdtemp(join(destination, ".mount-"));
  try {
    // Inside the try, so a mount stopped halfway is still detached and its folder removed.
    await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mountPoint, archive], { signal });
    await run("ditto", [join(mountPoint, "Blender.app"), join(destination, "Blender.app")], { signal });
  } finally {
    await run("hdiutil", ["detach", "-quiet", mountPoint]).catch(() => {});
    await rm(mountPoint, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultUnpackBlender(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith(".dmg")) return unpackDmg(archive, destination, signal);
  if (archive.endsWith(".zip")) return unzip(archive, destination, signal);
  // tar on its own can't read .xz, but every Linux desktop has the system's.
  await run("tar", ["-xJf", archive, "-C", destination], { signal });
}

export async function unpackUv(
  archive: string,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  if (archive.endsWith(".zip")) {
    await unzip(archive, destination, signal);
    return join(destination, "uv.exe");
  }
  // Streamed rather than read by path, so Stop can end it part-way.
  await pipeline(
    createReadStream(archive),
    extractTar({ cwd: destination, strip: 1 }) as unknown as NodeJS.WritableStream,
    { signal },
  );
  const executable = join(destination, "uv");
  await chmod(executable, 0o755);
  return executable;
}

const DEFAULT_UNPACK = {
  blender: defaultUnpackBlender,
  uv: unpackUv,
  server: unzip,
};

/** Runs inside Blender: turns the add-on on and has it listen whenever Blender opens. */
const ADDON_PREFERENCES_SCRIPT = `
import addon_utils, bpy
addon_utils.enable("${ADDON_MODULE}", default_set=True, persistent=True)
preferences = bpy.context.preferences.addons["${ADDON_MODULE}"].preferences
preferences.port = ${BLENDER_MCP_PORT}
preferences.use_autostart = True
bpy.context.preferences.system.use_online_access = True
bpy.ops.wm.save_userpref()
`;

async function defaultRunCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  await run(command, [...args], { env: environment, timeout: COMMAND_TIMEOUT_MS, signal });
}

async function installEverything(options: BlenderToolsOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const files = filesFor(platform, arch);
  if (!files) {
    throw new BlenderToolsError({
      message: "Blender can't be set up on this computer",
      reason: "other",
    });
  }
  const { root } = options;
  await mkdir(root, { recursive: true });
  const free = await (options.freeBytes ?? defaultFreeBytes)(root);
  if (free < BLENDER_MIN_FREE_BYTES) {
    throw new BlenderToolsError({
      message: "This needs about 2 GB free",
      reason: "disk_full",
    });
  }

  // Anything left of an earlier try is only trusted again once it's finished properly.
  await rm(markerPath(root), { force: true });
  const downloads = join(root, "downloads");
  const pinned = [files.blender, files.uv, MCP_ADDON, MCP_SERVER];
  const totalBytes = pinned.reduce((sum, file) => sum + file.bytes, 0);
  const received = new Map<string, number>();
  const report = (step: BlenderSetupStep) =>
    options.onProgress?.({
      step,
      downloadedBytes: [...received.values()].reduce((sum, bytes) => sum + bytes, 0),
      totalBytes,
    });
  // One failure stops the rest, and setup only ends once they have, so a retry never writes the same
  // partial files as downloads still running from before.
  const together = new AbortController();
  const stopAll = () => together.abort();
  // Stop may have come during the checks above, after which its event won't fire again.
  if (options.signal?.aborted) throw new SetupCancelled();
  options.signal?.addEventListener("abort", stopAll, { once: true });
  const downloaded = await Promise.allSettled(
    pinned.map((file) =>
      (options.download ?? downloadPinned)(file, downloads, {
        ...options,
        signal: together.signal,
        onBytes: (bytes) => {
          received.set(file.name, bytes);
          report("downloading");
        },
      }).catch((error: unknown) => {
        together.abort();
        throw error;
      }),
    ),
  );
  options.signal?.removeEventListener("abort", stopAll);
  if (options.signal?.aborted) throw new SetupCancelled();
  const failed = downloaded.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !(result.reason instanceof SetupCancelled),
  );
  if (failed) throw failed.reason;
  const cancelled = downloaded.find((result) => result.status === "rejected");
  if (cancelled) throw (cancelled as PromiseRejectedResult).reason;
  const [blenderArchive, uvArchive, addon, server] = downloaded.map(
    (result) => (result as PromiseFulfilledResult<string>).value,
  );

  if (options.signal?.aborted) throw new SetupCancelled();
  report("unpacking");
  // Like the commands below, so Stop lands between unpacks and ends one that's running.
  const unpacking = async <T>(step: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    if (options.signal?.aborted) throw new SetupCancelled();
    try {
      return await step(options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new SetupCancelled();
      throw error;
    }
  };
  const blenderHome = blenderDirectory(root);
  await rm(blenderHome, { recursive: true, force: true });
  const unpack = options.unpack ?? DEFAULT_UNPACK;
  await unpacking((signal) => unpack.blender(blenderArchive, blenderHome, signal));
  const uvExecutable = await unpacking((signal) => unpack.uv(uvArchive, join(root, "uv"), signal));

  const serverHome = serverDirectory(root);
  await rm(serverHome, { recursive: true, force: true });
  await mkdir(serverHome, { recursive: true });
  await unpacking((signal) => unpack.server(server, serverHome, signal));
  // The bundle pins nothing itself, so what it runs on is decided here rather than on the day.
  await writeFile(join(serverHome, "uv.lock"), uvLock);
  await writeFile(join(serverHome, ".python-version"), `${PYTHON_VERSION}\n`);

  if (options.signal?.aborted) throw new SetupCancelled();
  report("connecting");
  // Stop has to reach these too, or setup would carry on and finish after being stopped.
  const runCommand = async (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => {
    if (options.signal?.aborted) throw new SetupCancelled();
    try {
      await (options.runCommand ?? defaultRunCommand)(command, args, environment, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new SetupCancelled();
      throw error;
    }
  };
  await runCommand(
    uvExecutable,
    ["sync", "--frozen", "--no-dev", "--directory", serverHome, "--python", PYTHON_VERSION],
    uvEnvironment(root),
  );

  const executable = blenderExecutable(root, platform);
  const environment = blenderEnvironment(root);
  await mkdir(userResources(root), { recursive: true });
  await runCommand(
    executable,
    ["--factory-startup", "--background", "--online-mode", "--command", "extension", "install-file", "-r", "user_default", "-e", addon],
    environment,
  );
  await runCommand(
    executable,
    ["--background", "--online-mode", "--python-exit-code", "1", "--python-expr", ADDON_PREFERENCES_SCRIPT],
    environment,
  );

  await rm(downloads, { recursive: true, force: true });
  await writeFile(
    markerPath(root),
    JSON.stringify({ blender: BLENDER_VERSION, mcp: MCP_VERSION, uv: UV_VERSION }),
  );
}

const defaultFreeBytes = async (path: string) => {
  const { bavail, bsize } = await statfs(path);
  return bavail * bsize;
};

export function installBlenderTools(
  options: BlenderToolsOptions,
): Effect.Effect<void, BlenderToolsError> {
  return Effect.tryPromise({
    try: () => installEverything(options),
    catch: (cause) => {
      if (cause instanceof BlenderToolsError) return cause;
      if (cause instanceof SetupCancelled) {
        return new BlenderToolsError({ message: "Setup was stopped", reason: "other", cause });
      }
      return new BlenderToolsError({
        message: "Blender couldn't be set up",
        reason: classify(cause),
        cause,
      });
    },
  });
}

/** Whether something's listening where Blender would be, which is all there is to ask it. */
function isBlenderListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: BLENDER_MCP_PORT });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export async function isBlenderInstalled(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  // A marker cut short counts as not installed, so it can never stop OpenCode starting.
  const marked = await readFile(markerPath(root), "utf8").then(
    (contents) => {
      try {
        return JSON.parse(contents).blender === BLENDER_VERSION;
      } catch {
        return false;
      }
    },
    () => false,
  );
  if (!marked) return false;
  // Security software can remove either one after setup, and setting up again puts it back.
  const found = await Promise.all([
    exists(blenderExecutable(root, platform)),
    exists(serverExecutable(root, platform)),
  ]);
  return found.every(Boolean);
}

export async function getBlenderToolsState(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<BlenderToolsState> {
  if (!filesFor(platform, arch)) return { state: "unsupported" };
  if (!(await isBlenderInstalled(root, platform))) return { state: "not_installed" };
  return { state: "ready", running: await isBlenderListening() };
}

/** Resolves once Blender has started. A failed spawn only reports as an event, which would crash the app unheard. */
export function openBlender(root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(blenderExecutable(root, platform), ["--online-mode"], {
      detached: true,
      stdio: "ignore",
      env: blenderEnvironment(root),
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function removeBlenderTools(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true });
}
