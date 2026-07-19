import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";

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

export function parseOpenCodeListeningPort(output: string): number | null {
  const match = output.match(/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/);
  if (!match) return null;

  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

async function waitForListeningPort(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (data: Buffer) => {
      output += data.toString();
      const port = parseOpenCodeListeningPort(output);
      if (port !== null) {
        cleanup();
        resolve(port);
      }
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null) =>
      fail(new Error(`OpenCode exited during startup with code ${code}`));
    const timeout = setTimeout(
      () => fail(new Error("OpenCode did not report a listening port within 60 seconds")),
      STARTUP_TIMEOUT_MS,
    );

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
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
