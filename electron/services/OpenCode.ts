import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Effect, Layer } from "effect";
import { networkConnections, type Systeminformation } from "systeminformation";

import type { OpenCodeInfo, OpenCodeStartupProgress } from "../../src/types/desktop";
import { createOpenCodeConfig } from "../opencodeConfig";
import { ensureOpenCodeBinary } from "./OpenCodeBinary";
import { StudioMcpBroker } from "./StudioMcpBroker";

const LOOPBACK = "127.0.0.1";
const STARTUP_TIMEOUT = "60 seconds";
const SERVER_USERNAME = "opencode";

export class OpenCodeError extends Data.TaggedError("OpenCodeError")<{
  message: string;
  cause?: unknown;
}> {}

interface OpenCodeProcess {
  authorization: string;
  child: ChildProcessWithoutNullStreams;
  workspace: string;
}

interface OpenCodeResource extends OpenCodeProcess {
  port: number;
}

interface PreparedOpenCode {
  authorization: string;
  executable: string;
  password: string;
  workspace: string;
  xdgCache: string;
  xdgConfig: string;
  xdgData: string;
  xdgState: string;
}

export interface OpenCodeOptions {
  binaryCacheDirectory: string;
  workspace: string;
  onStartupProgress?: (progress: OpenCodeStartupProgress) => void;
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
): Effect.Effect<number | null, OpenCodeError> {
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
    return Effect.fail(
      new OpenCodeError({
        message: `OpenCode is listening on multiple loopback ports: ${[...ports].join(", ")}`,
      }),
    );
  }
  return Effect.succeed(ports.values().next().value ?? null);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Effect.Effect<void, OpenCodeError> {
  return Effect.async<void, OpenCodeError>((resume) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      cleanup();
      resume(Effect.fail(new OpenCodeError({ message: "Failed to spawn OpenCode", cause })));
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);

    return Effect.sync(cleanup);
  });
}

function pollListeningPort(
  child: ChildProcessWithoutNullStreams,
  pid: number,
): Effect.Effect<number, OpenCodeError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) {
      return yield* Effect.fail(
        new OpenCodeError({
          message: `OpenCode exited during startup with code ${child.exitCode}`,
        }),
      );
    }

    const connections = yield* Effect.tryPromise({
      try: () => networkConnections(),
      catch: (cause) =>
        new OpenCodeError({ message: "Failed to inspect OpenCode network listeners", cause }),
    });
    const port = yield* findOpenCodeListeningPort(connections, pid);
    if (port !== null) return port;
    yield* Effect.sleep("500 millis");
    return yield* Effect.suspend(() => pollListeningPort(child, pid));
  });
}

function waitForListeningPort(child: ChildProcessWithoutNullStreams) {
  if (child.pid === undefined) {
    return Effect.fail(new OpenCodeError({ message: "OpenCode started without a process ID" }));
  }
  return pollListeningPort(child, child.pid).pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        new OpenCodeError({ message: "OpenCode did not open a listening port within 60 seconds" }),
    }),
  );
}

function pollHealth(
  child: ChildProcessWithoutNullStreams,
  healthUrl: string,
  authorization: string,
): Effect.Effect<void, OpenCodeError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) {
      return yield* Effect.fail(
        new OpenCodeError({
          message: `OpenCode exited during startup with code ${child.exitCode}`,
        }),
      );
    }

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(healthUrl, {
          headers: { Authorization: authorization },
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        }),
      catch: (cause) =>
        new OpenCodeError({ message: "OpenCode health check did not respond", cause }),
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (response?.ok) return;
    yield* Effect.sleep("500 millis");
    return yield* Effect.suspend(() => pollHealth(child, healthUrl, authorization));
  });
}

function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  port: number,
  authorization: string,
): Effect.Effect<void, OpenCodeError> {
  const healthUrl = `http://${LOOPBACK}:${port}/global/health`;
  return pollHealth(child, healthUrl, authorization).pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        new OpenCodeError({ message: "OpenCode did not become healthy within 60 seconds" }),
    }),
  );
}

function prepareOpenCode(
  options: OpenCodeOptions,
): Effect.Effect<PreparedOpenCode, OpenCodeError, StudioMcpBroker> {
  return Effect.gen(function* () {
    const broker = yield* StudioMcpBroker;
    const { executable, version } = yield* ensureOpenCodeBinary({
      cacheDirectory: options.binaryCacheDirectory,
      onStartupProgress: options.onStartupProgress,
    }).pipe(
      Effect.mapError(
        (cause) => new OpenCodeError({ message: cause.message, cause }),
      ),
    );
    yield* Effect.sync(() => options.onStartupProgress?.({ phase: "starting" }));
    yield* Effect.logInfo(`[opencode] Starting v${version}`);

    const opencodeHome = join(options.workspace, ".opencode");
    const xdgData = join(opencodeHome, "data");
    const xdgConfig = join(opencodeHome, "config");
    const xdgCache = join(opencodeHome, "cache");
    const xdgState = join(opencodeHome, "state");
    const configDirectory = join(xdgConfig, "opencode");
    const fileOperation = <A>(message: string, evaluate: () => PromiseLike<A>) =>
      Effect.tryPromise({
        try: evaluate,
        catch: (cause) => new OpenCodeError({ message, cause }),
      });

    yield* Effect.all(
      [options.workspace, xdgData, configDirectory, xdgCache, xdgState].map((directory) =>
        fileOperation(`Failed to create ${directory}`, () => mkdir(directory, { recursive: true })),
      ),
      { concurrency: "unbounded", discard: true },
    );
    const config = createOpenCodeConfig(broker.info);
    yield* fileOperation("Failed to write the OpenCode configuration", () =>
      writeFile(
        join(configDirectory, "opencode.json"),
        JSON.stringify(config, null, 2),
      ),
    );

    const password = yield* Effect.try({
      try: () => randomBytes(32).toString("base64url"),
      catch: (cause) =>
        new OpenCodeError({ message: "Failed to generate OpenCode credentials", cause }),
    });
    const authorization = `Basic ${Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64")}`;
    return {
      authorization,
      executable,
      password,
      workspace: options.workspace,
      xdgCache,
      xdgConfig,
      xdgData,
      xdgState,
    };
  });
}

function spawnOpenCode(prepared: PreparedOpenCode): Effect.Effect<OpenCodeProcess, OpenCodeError> {
  return Effect.gen(function* () {
    const child = yield* Effect.try({
      try: () =>
        spawn(
          prepared.executable,
          ["serve", "--port", "0", "--hostname", LOOPBACK, "--print-logs", "--log-level", "INFO"],
          {
            cwd: prepared.workspace,
            env: {
              ...process.env,
              XDG_CACHE_HOME: prepared.xdgCache,
              XDG_CONFIG_HOME: prepared.xdgConfig,
              XDG_DATA_HOME: prepared.xdgData,
              XDG_STATE_HOME: prepared.xdgState,
              OPENCODE_SERVER_PASSWORD: prepared.password,
              OPENCODE_SERVER_USERNAME: SERVER_USERNAME,
            },
            stdio: "pipe",
            windowsHide: true,
          },
        ),
      catch: (cause) => new OpenCodeError({ message: "Failed to start OpenCode", cause }),
    });

    child.stdout.on("data", (data: Buffer) =>
      Effect.runSync(Effect.logInfo(`[opencode] ${data.toString().trimEnd()}`)),
    );
    child.stderr.on("data", (data: Buffer) =>
      Effect.runSync(Effect.logError(`[opencode] ${data.toString().trimEnd()}`)),
    );
    return {
      authorization: prepared.authorization,
      child,
      workspace: prepared.workspace,
    };
  });
}

function stopOpenCode(resource: OpenCodeProcess): Effect.Effect<void> {
  return Effect.suspend(() => {
    if (resource.child.exitCode !== null || resource.child.pid === undefined) return Effect.void;

    const exitedAfterTerminate = Effect.async<void>((resume) => {
      const cleanup = () => resource.child.off("exit", onExit);
      const onExit = () => {
        cleanup();
        resume(Effect.void);
      };
      resource.child.once("exit", onExit);
      if (resource.child.exitCode !== null) {
        onExit();
      } else if (!resource.child.killed) {
        resource.child.kill("SIGTERM");
      }
      return Effect.sync(cleanup);
    });
    const forceKill = Effect.sleep("5 seconds").pipe(
      Effect.tap(() => Effect.sync(() => resource.child.kill("SIGKILL"))),
    );
    return Effect.race(exitedAfterTerminate, forceKill);
  });
}

function awaitOpenCode(process: OpenCodeProcess): Effect.Effect<OpenCodeResource, OpenCodeError> {
  return Effect.gen(function* () {
    yield* waitForSpawn(process.child);
    const port = yield* waitForListeningPort(process.child);
    yield* waitForHealth(process.child, port, process.authorization);
    return { ...process, port };
  });
}

export function makeOpenCodeLayer(options: OpenCodeOptions) {
  return Layer.scoped(
    OpenCode,
    Effect.gen(function* () {
      // Downloading and readiness polling remain interruptible. Only the short spawn
      // operation is masked, and its finalizer is registered before any waiting begins.
      const prepared = yield* prepareOpenCode(options);
      const process = yield* Effect.acquireRelease(spawnOpenCode(prepared), stopOpenCode);
      const resource = yield* awaitOpenCode(process);
      return {
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
      } satisfies OpenCodeService;
    }),
  );
}
