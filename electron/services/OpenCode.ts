import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";
import { networkConnections, type Systeminformation } from "systeminformation";

import type { OpenCodeInfo } from "../../src/types/desktop";
import { createOpenCodeConfig } from "../opencodeConfig";
import { ensureOpenCodeBinary } from "./OpenCodeBinary";

const LOOPBACK = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60_000;
const SERVER_USERNAME = "opencode";

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

type NetworkConnection = Pick<
  Systeminformation.NetworkConnectionsData,
  "localAddress" | "localPort" | "pid" | "protocol" | "state"
>;

export function findOpenCodeListeningPort(
  connections: readonly NetworkConnection[],
  pid: number,
): number | null {
  const ports = new Set(
    connections
      .filter(
        (connection) =>
          connection.pid === pid &&
          connection.protocol.startsWith("tcp") &&
          connection.localAddress === LOOPBACK &&
          connection.state === "LISTEN",
      )
      .map((connection) => Number(connection.localPort))
      .filter(Number.isInteger),
  );

  if (ports.size > 1) {
    throw new Error(`OpenCode is listening on multiple loopback ports: ${[...ports].join(", ")}`);
  }
  return ports.values().next().value ?? null;
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function waitForListeningPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.pid === undefined) throw new Error("OpenCode started without a process ID");

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode exited during startup with code ${child.exitCode}`);
    }

    const port = findOpenCodeListeningPort(await networkConnections(), child.pid);
    if (port !== null) return port;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("OpenCode did not open a listening port within 60 seconds");
}

async function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  port: number,
  authorization: string,
): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const healthUrl = `http://${LOOPBACK}:${port}/global/health`;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`OpenCode exited during startup with code ${child.exitCode}`);
    }

    try {
      const response = await fetch(healthUrl, {
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The server is still starting. Retry until the explicit deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("OpenCode did not become healthy within 60 seconds");
}

async function startOpenCode(options: OpenCodeOptions): Promise<OpenCodeResource> {
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

  const password = randomBytes(32).toString("base64url");
  const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}`;

  const child = spawn(
    executable,
    ["serve", "--port", "0", "--hostname", LOOPBACK, "--print-logs", "--log-level", "INFO"],
    {
      cwd: options.workspace,
      env: {
        ...process.env,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
      },
      stdio: "pipe",
      windowsHide: true,
    },
  );

  child.stdout.on("data", (data: Buffer) => console.info(`[opencode] ${data.toString().trimEnd()}`));
  child.stderr.on("data", (data: Buffer) => console.error(`[opencode] ${data.toString().trimEnd()}`));

  try {
    await waitForSpawn(child);
    const listeningPort = await waitForListeningPort(child);
    await waitForHealth(child, listeningPort, authorization);
    return { authorization, child, port: listeningPort, workspace: options.workspace };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
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
          return Effect.succeed({
            authorization: resource.authorization,
            port: resource.port,
            workspace: resource.workspace,
          });
        }),
      })),
    ),
  );
}
