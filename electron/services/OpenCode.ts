import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Duration, Effect, Layer } from "effect";
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
  output: OpenCodeOutputTail;
  workspace: string;
}

const OUTPUT_TAIL_MAX_CHARS = 2048;
const OUTPUT_TAIL_IN_ERROR_CHARS = 400;

/** The last couple of KB OpenCode printed, so a startup failure can say why. */
export interface OpenCodeOutputTail {
  readonly stderr: () => string;
  readonly stdout: () => string;
  /** Resolves once the process has exited and its output streams are flushed. */
  readonly closed: Promise<void>;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_MAX_CHARS ? next.slice(-OUTPUT_TAIL_MAX_CHARS) : next;
}

/** Logs OpenCode's output and keeps a bounded tail of each stream. */
export function trackOpenCodeOutput(child: ChildProcessWithoutNullStreams): OpenCodeOutputTail {
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout = appendBounded(stdout, text);
    Effect.runSync(Effect.logInfo(`[opencode] ${text.trimEnd()}`));
  });
  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    stderr = appendBounded(stderr, text);
    Effect.runSync(Effect.logError(`[opencode] ${text.trimEnd()}`));
  });
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    closed: new Promise((resolve) => child.once("close", () => resolve())),
  };
}

/** Appends the end of OpenCode's stderr (or stdout when stderr is empty) to a message. */
export function withOutputTail(message: string, output: OpenCodeOutputTail): string {
  const raw = output.stderr().trim() ? output.stderr() : output.stdout();
  const tail = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes.
    .replace(/\u001b\[[\d;]*m/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-OUTPUT_TAIL_IN_ERROR_CHARS);
  return tail ? `${message}. Output: ${tail}` : message;
}

function exitedDuringStartup(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
): Effect.Effect<never, OpenCodeError> {
  // "exit" can fire before the last output arrives; give the streams a moment to flush.
  return Effect.promise(() => output.closed).pipe(
    Effect.timeout("1 second"),
    Effect.ignore,
    Effect.flatMap(() =>
      Effect.fail(
        new OpenCodeError({
          message: withOutputTail(
            `OpenCode exited during startup with code ${child.exitCode}`,
            output,
          ),
        }),
      ),
    ),
  );
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
  output: OpenCodeOutputTail,
  pid: number,
): Effect.Effect<number, OpenCodeError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) return yield* exitedDuringStartup(child, output);

    const connections = yield* Effect.tryPromise({
      try: () => networkConnections(),
      catch: (cause) =>
        new OpenCodeError({ message: "Failed to inspect OpenCode network listeners", cause }),
    });
    const port = yield* findOpenCodeListeningPort(connections, pid);
    if (port !== null) return port;
    yield* Effect.sleep("500 millis");
    return yield* Effect.suspend(() => pollListeningPort(child, output, pid));
  });
}

export function waitForListeningPort(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  timeout: Duration.DurationInput = STARTUP_TIMEOUT,
) {
  if (child.pid === undefined) {
    return Effect.fail(new OpenCodeError({ message: "OpenCode started without a process ID" }));
  }
  return pollListeningPort(child, output, child.pid).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        new OpenCodeError({
          message: withOutputTail(
            `OpenCode did not open a listening port within ${Math.round(Duration.toSeconds(timeout))} seconds`,
            output,
          ),
        }),
    }),
  );
}

function pollHealth(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  healthUrl: string,
  authorization: string,
): Effect.Effect<void, OpenCodeError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) return yield* exitedDuringStartup(child, output);

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
    return yield* Effect.suspend(() => pollHealth(child, output, healthUrl, authorization));
  });
}

function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  port: number,
  authorization: string,
): Effect.Effect<void, OpenCodeError> {
  const healthUrl = `http://${LOOPBACK}:${port}/global/health`;
  return pollHealth(child, output, healthUrl, authorization).pipe(
    Effect.timeoutFail({
      duration: STARTUP_TIMEOUT,
      onTimeout: () =>
        new OpenCodeError({
          message: withOutputTail("OpenCode did not become healthy within 60 seconds", output),
        }),
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

    return {
      authorization: prepared.authorization,
      child,
      output: trackOpenCodeOutput(child),
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
    const port = yield* waitForListeningPort(process.child, process.output);
    yield* waitForHealth(process.child, process.output, port, process.authorization);
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
                message: withOutputTail(
                  `OpenCode stopped unexpectedly with code ${resource.child.exitCode}`,
                  resource.output,
                ),
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
