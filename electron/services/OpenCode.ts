import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";

import type { OpenCodeInfo } from "../../src/types/desktop";
import { createOpenCodeConfig } from "../opencodeConfig";
import { ensureOpenCodeBinary } from "./OpenCodeBinary";

const LOOPBACK = "127.0.0.1";
const PORT_START = 59200;
const PORT_COUNT = 10;
const STARTUP_TIMEOUT_MS = 60_000;

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  message: string;
  cause?: unknown;
}> {}

interface OpenCodeResource extends OpenCodeInfo {
  child: ChildProcessWithoutNullStreams;
}

export interface OpenCodeOptions {
  binaryCacheDirectory: string;
  workspace: string;
}

export interface OpenCodeService {
  readonly info: Effect.Effect<OpenCodeInfo, OpenCodeError>;
}

export class OpenCode extends Context.Tag("@bloxbot/OpenCode")<OpenCode, OpenCodeService>() {}

async function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, LOOPBACK, () => server.close(() => resolve(true)));
  });
}

async function findAvailablePort(): Promise<number> {
  for (let offset = 0; offset < PORT_COUNT; offset++) {
    const port = PORT_START + offset;
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port in ${PORT_START}-${PORT_START + PORT_COUNT - 1}`);
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function waitForHealth(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const healthUrl = `http://${LOOPBACK}:${port}/global/health`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode exited during startup with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The server is still starting. Retry until the explicit deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("OpenCode did not become healthy within 60 seconds");
}

async function startOpenCode(options: OpenCodeOptions): Promise<OpenCodeResource> {
  const port = await findAvailablePort();
  const { executable, version } = await ensureOpenCodeBinary({
    cacheDirectory: options.binaryCacheDirectory,
  });
  console.info(`[opencode] Starting v${version}`);
  const opencodeHome = join(options.workspace, ".opencode");
  const xdgData = join(opencodeHome, "data");
  const xdgConfig = join(opencodeHome, "config");
  const xdgCache = join(opencodeHome, "cache");
  const xdgState = join(opencodeHome, "state");
  const configDirectory = join(xdgConfig, "opencode");

  await Promise.all(
    [options.workspace, xdgData, configDirectory, xdgCache, xdgState].map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await writeFile(
    join(configDirectory, "opencode.json"),
    JSON.stringify(createOpenCodeConfig(), null, 2),
  );

  const child = spawn(
    executable,
    ["serve", "--port", String(port), "--hostname", LOOPBACK, "--print-logs", "--log-level", "INFO"],
    {
      cwd: options.workspace,
      env: {
        ...process.env,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
      },
      stdio: "pipe",
      windowsHide: true,
    },
  );

  child.stdout.on("data", (data: Buffer) => console.info(`[opencode] ${data.toString().trimEnd()}`));
  child.stderr.on("data", (data: Buffer) => console.error(`[opencode] ${data.toString().trimEnd()}`));

  try {
    await waitForSpawn(child);
    await waitForHealth(child, port);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return { child, port, workspace: options.workspace };
}

async function stopOpenCode(resource: OpenCodeResource): Promise<void> {
  if (resource.child.exitCode !== null || resource.child.killed) return;

  resource.child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => resource.child.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        resource.child.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

function acquire(options: OpenCodeOptions) {
  return Effect.tryPromise({
    try: () => startOpenCode(options),
    catch: (cause) =>
      new OpenCodeError({
        message:
          cause instanceof Error
            ? cause.message
            : "OpenCode failed to download or start.",
        cause,
      }),
  });
}

function release(resource: OpenCodeResource) {
  return Effect.promise(() => stopOpenCode(resource));
}

export function makeOpenCodeLayer(options: OpenCodeOptions) {
  return Layer.scoped(
    OpenCode,
    Effect.acquireRelease(acquire(options), release).pipe(
      Effect.map((resource): OpenCodeService => ({
        info: Effect.suspend(() => {
          if (resource.child.exitCode !== null) {
            return Effect.fail(
              new OpenCodeError({
                message: `OpenCode stopped unexpectedly with code ${resource.child.exitCode}`,
              }),
            );
          }
          return Effect.succeed({ port: resource.port, workspace: resource.workspace });
        }),
      })),
    ),
  );
}
