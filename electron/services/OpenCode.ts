import { type ChildProcessWithoutNullStreams, exec, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Context, Data, Duration, Effect, Layer, Option } from "effect";
import { networkConnections, type Systeminformation } from "systeminformation";

import type { OpenCodeInfo, OpenCodeStartupProgress } from "../../src/types/desktop";
import type { blenderMcpServerConfig } from "./BlenderTools";
import { createOpenCodeConfig, OPENCODE_ISOLATION_ENV } from "../opencodeConfig";
import { loadShellPath } from "../shellEnv";
import {
  distrustOpenCodeVersion,
  ensureOpenCodeBinary,
  findOpenCodeFallback,
  type OpenCodeBinaryOptions,
} from "./OpenCodeBinary";
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
  /** Resolves with the port OpenCode says it is listening on. It may never settle. */
  readonly announcedPort: Promise<number>;
}

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL_MAX_CHARS ? next.slice(-OUTPUT_TAIL_MAX_CHARS) : next;
}

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes.
  return text.replace(/\u001b\[[\d;]*m/g, "");
}

// The address we told OpenCode to bind, so nothing else it might print can be mistaken for it.
const LISTENING_LINE = /\bserver listening on http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/;

/** The port in OpenCode's "server listening on" line, or null for any other line. */
export function parseListeningPort(line: string): number | null {
  const port = Number(LISTENING_LINE.exec(stripAnsi(line).trimEnd())?.[1]);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Calls onLine with whole lines only: a port cut off by a chunk boundary would read as valid. */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let partial = "";
  return (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = (lines.pop() ?? "").slice(-OUTPUT_TAIL_MAX_CHARS);
    lines.forEach(onLine);
  };
}

/** Logs OpenCode's output, keeps a bounded tail of each stream and watches for its port. */
export function trackOpenCodeOutput(child: ChildProcessWithoutNullStreams): OpenCodeOutputTail {
  let stderr = "";
  let stdout = "";
  let announce: (port: number) => void = () => {};
  const announcedPort = new Promise<number>((resolve) => {
    announce = resolve;
  });
  const onLine = (line: string) => {
    const port = parseListeningPort(line);
    if (port !== null) announce(port);
  };
  const scanStdout = lineSplitter(onLine);
  const scanStderr = lineSplitter(onLine);
  child.stdout.on("data", (data: Buffer) => {
    const text = data.toString();
    stdout = appendBounded(stdout, text);
    scanStdout(text);
    Effect.runSync(Effect.logInfo(`[opencode] ${text.trimEnd()}`));
  });
  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    stderr = appendBounded(stderr, text);
    scanStderr(text);
    Effect.runSync(Effect.logError(`[opencode] ${text.trimEnd()}`));
  });
  return {
    stderr: () => stderr,
    stdout: () => stdout,
    closed: new Promise((resolve) => child.once("close", () => resolve())),
    announcedPort,
  };
}

/** Appends the end of OpenCode's stderr (or stdout when stderr is empty) to a message. */
export function withOutputTail(
  message: string,
  output: Pick<OpenCodeOutputTail, "stderr" | "stdout">,
): string {
  const raw = output.stderr().trim() ? output.stderr() : output.stdout();
  const tail = stripAnsi(raw)
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
            `OpenCode exited during startup with code ${child.exitCode ?? child.signalCode}`,
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
  version: string;
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
  loadSystemPrompt?: () => Effect.Effect<string | null>;
  loadBlenderServer?: () => Effect.Effect<ReturnType<typeof blenderMcpServerConfig> | null>;
  binaryCacheDirectory: string;
  fetchWithSystemCertificates?: OpenCodeBinaryOptions["fetchWithSystemCertificates"];
  workspace: string;
  onStartupProgress?: (progress: OpenCodeStartupProgress) => void;
  /** Windows only: OpenCode started fine, but netstat wouldn't have found it. */
  onNetstatMiss?: (error: OpenCodeError) => void;
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
      const reason = (cause as NodeJS.ErrnoException).code ?? cause.message;
      resume(Effect.fail(new OpenCodeError({ message: `Failed to spawn OpenCode: ${reason}`, cause })));
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);

    return Effect.sync(cleanup);
  });
}

/** Fails as soon as the process exits, however the rest of startup is getting on. */
function failOnExit(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
): Effect.Effect<never, OpenCodeError> {
  return Effect.async<void>((resume) => {
    const onExit = () => resume(Effect.void);
    if (child.exitCode !== null || child.signalCode !== null) return onExit();
    child.once("exit", onExit);
    return Effect.sync(() => child.off("exit", onExit));
  }).pipe(Effect.flatMap(() => exitedDuringStartup(child, output)));
}

export interface PortLookup {
  /**
   * The system's network connections. On Windows, systeminformation never settles this if
   * netstat can't start or exits with an error, so a call that stays pending is what such a
   * failure looks like from here.
   */
  readonly connections: () => Promise<readonly NetworkConnection[]>;
  /** Runs netstat directly and says how it went, or null where that would tell us nothing. */
  readonly probe: (pid: number) => Promise<string | null>;
}

const NETSTAT_CHECK_TIMEOUT = "15 seconds";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_DETAIL_MAX_CHARS = 120;

/** Runs the command systeminformation runs on Windows, but keeps the error it would swallow. */
function probeNetstat(pid: number): Promise<string> {
  return new Promise((resolve) => {
    exec(
      "netstat -nao",
      { maxBuffer: 1024 * 102400, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr.trim() || error.message).replace(/\s+/g, " ");
          resolve(
            `failed with ${error.code ?? error.signal}: ${detail.slice(0, PROBE_DETAIL_MAX_CHARS)}`,
          );
          return;
        }
        const rows = stdout.split("\n").filter((line) => /^\s*(TCP|UDP)\s/i.test(line));
        const owned = rows.filter((line) => line.trim().endsWith(` ${pid}`));
        resolve(`ok with ${rows.length} rows, ${owned.length} for the pid`);
      },
    );
  });
}

const systemPortLookup: PortLookup = {
  connections: () => networkConnections(),
  probe: (pid) => (process.platform === "win32" ? probeNetstat(pid) : Promise.resolve(null)),
};

/** What the netstat lookups have seen so far, for when the port never turns up. */
interface NetstatSightings {
  started: number;
  returned: number;
  rows: number;
  listening: number;
  rowsForPid: number;
  listenersForPid: string[];
  problem: string | null;
}

const noSightings = (): NetstatSightings => ({
  started: 0,
  returned: 0,
  rows: 0,
  listening: 0,
  rowsForPid: 0,
  listenersForPid: [],
  problem: null,
});

function recordNetstatRows(
  sightings: NetstatSightings,
  connections: readonly NetworkConnection[],
  pid: number,
): void {
  const owned = connections.filter((connection) => connection.pid === pid);
  sightings.returned += 1;
  sightings.rows = connections.length;
  sightings.listening = connections.filter((connection) => connection.state === "LISTEN").length;
  sightings.rowsForPid = owned.length;
  sightings.listenersForPid = owned
    .filter((connection) => connection.state === "LISTEN")
    .map((connection) => {
      // Telling our own bind from a wildcard is all this is for; a LAN address stays private.
      const local = /^(127\.|0\.0\.0\.0$|::1?$)/.test(connection.localAddress);
      return `${local ? connection.localAddress : "other"}:${connection.localPort}`;
    });
}

/** Says what the lookups saw, asking netstat directly if none of them ever came back. */
function describeNetstat(
  sightings: NetstatSightings,
  lookup: PortLookup,
  pid: number,
): Effect.Effect<string> {
  const calls = `netstat ${sightings.returned} of ${sightings.started} calls returned`;
  const problem = sightings.problem ? `, ${sightings.problem}` : "";
  if (sightings.returned > 0) {
    const listeners = sightings.listenersForPid.slice(0, 3).join(" ") || "none";
    return Effect.succeed(
      `${calls}, last ${sightings.rows} rows, ${sightings.listening} listening, ${sightings.rowsForPid} for pid ${pid}, its listeners ${listeners}${problem}`,
    );
  }
  return Effect.tryPromise(() => lookup.probe(pid)).pipe(
    // Killing the shell at the timeout can leave netstat holding the pipes open.
    Effect.timeoutTo({
      duration: PROBE_TIMEOUT_MS + 1_000,
      onSuccess: (probe) => (probe ? `, direct netstat ${probe}` : ""),
      onTimeout: () => ", direct netstat hung",
    }),
    Effect.orElseSucceed(() => ", direct netstat could not run"),
    Effect.map((probe) => `${calls}${problem}${probe}`),
  );
}

function pollListeningPort(
  lookup: PortLookup,
  pid: number,
  sightings: NetstatSightings,
): Effect.Effect<number> {
  return Effect.gen(function* () {
    sightings.started += 1;
    const port = yield* Effect.tryPromise(() => lookup.connections()).pipe(
      Effect.tap((connections) => recordNetstatRows(sightings, connections, pid)),
      // OpenCode's output may still name the port, so a bad answer here doesn't end startup.
      Effect.flatMap((connections) => findOpenCodeListeningPort(connections, pid)),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          sightings.problem = error.message;
          return null;
        }),
      ),
    );
    if (port !== null) return port;
    yield* Effect.sleep("500 millis");
    return yield* Effect.suspend(() => pollListeningPort(lookup, pid, sightings));
  });
}

/**
 * OpenCode's output is the answer and netstat the fallback, in case that line ever changes. It
 * doesn't matter which gets there first: the port still has to pass the authenticated health check.
 */
export function waitForListeningPort(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  timeout: Duration.DurationInput = STARTUP_TIMEOUT,
  lookup: PortLookup = systemPortLookup,
): Effect.Effect<number, OpenCodeError> {
  const { pid } = child;
  if (pid === undefined) {
    return Effect.fail(new OpenCodeError({ message: "OpenCode started without a process ID" }));
  }
  return Effect.gen(function* () {
    const sightings = noSightings();
    const port = yield* Effect.raceFirst(
      Effect.promise(() => output.announcedPort),
      pollListeningPort(lookup, pid, sightings),
    ).pipe(Effect.raceFirst(failOnExit(child, output)), Effect.timeoutOption(timeout));
    if (Option.isSome(port)) return port.value;

    const netstat = yield* describeNetstat(sightings, lookup, pid);
    return yield* Effect.fail(
      new OpenCodeError({
        // Reports keep the first 500 characters, so what we saw goes ahead of OpenCode's output.
        message: withOutputTail(
          `OpenCode did not open a listening port within ${Math.round(Duration.toSeconds(timeout))} seconds. No port in its output, ${netstat}`,
          output,
        ),
      }),
    );
  });
}

/**
 * With OpenCode confirmed on a port, says how netstat's view differs, or null if it agrees. Reading
 * the port from the output means affected machines no longer time out, so this is the only report
 * left of why netstat misses it on them.
 */
export function explainNetstatMiss(
  pid: number,
  port: number,
  lookup: PortLookup = systemPortLookup,
  timeout: Duration.DurationInput = NETSTAT_CHECK_TIMEOUT,
): Effect.Effect<string | null> {
  return Effect.gen(function* () {
    const sightings = noSightings();
    sightings.started = 1;
    const connections = yield* Effect.tryPromise(() => lookup.connections()).pipe(
      Effect.timeoutOption(timeout),
      Effect.orElseSucceed(() => Option.none<readonly NetworkConnection[]>()),
    );
    const rows = Option.getOrElse(connections, (): readonly NetworkConnection[] => []);
    const holders = rows.filter(
      (row) =>
        Number(row.localPort) === port && row.state === "LISTEN" && row.protocol.startsWith("tcp"),
    );
    if (holders.some((row) => row.pid === pid && row.localAddress === LOOPBACK)) return null;

    if (Option.isSome(connections)) recordNetstatRows(sightings, rows, pid);
    const netstat = yield* describeNetstat(sightings, lookup, pid);
    const pids = holders.map((row) => row.pid).join(" ") || "nobody";
    return `OpenCode is on port ${port} but netstat doesn't show it for pid ${pid}: ${netstat}, port held by ${pids}`;
  });
}

/** Why a health check got no response, in a form that holds no credentials. */
function describeHealthFailure(cause: unknown): string {
  const inner = cause instanceof Error ? cause.cause : undefined;
  const code = inner && typeof inner === "object" && "code" in inner ? inner.code : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.name : "unknown error";
}

function pollHealth(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  healthUrl: string,
  authorization: string,
  lastFailure: { current: string },
): Effect.Effect<void, OpenCodeError> {
  return Effect.gen(function* () {
    if (child.exitCode !== null) return yield* exitedDuringStartup(child, output);

    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(healthUrl, {
          headers: { Authorization: authorization },
          signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        Effect.sync(() => {
          lastFailure.current = describeHealthFailure(cause);
          return null;
        }),
      ),
    );
    if (response?.ok) return;
    if (response) lastFailure.current = `HTTP ${response.status}`;
    yield* Effect.sleep("500 millis");
    return yield* Effect.suspend(() =>
      pollHealth(child, output, healthUrl, authorization, lastFailure),
    );
  });
}

export function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  output: OpenCodeOutputTail,
  port: number,
  authorization: string,
  timeout: Duration.DurationInput = STARTUP_TIMEOUT,
): Effect.Effect<void, OpenCodeError> {
  const healthUrl = `http://${LOOPBACK}:${port}/global/health`;
  const lastFailure = { current: "no response yet" };
  return pollHealth(child, output, healthUrl, authorization, lastFailure).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        new OpenCodeError({
          message: withOutputTail(
            `OpenCode did not become healthy on port ${port} within ${Math.round(Duration.toSeconds(timeout))} seconds. Last check: ${lastFailure.current}`,
            output,
          ),
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
      fetchWithSystemCertificates: options.fetchWithSystemCertificates,
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
        catch: (cause) =>
          new OpenCodeError({
            // The drive being full is something someone can act on, so it's worth naming.
            message:
              (cause as NodeJS.ErrnoException)?.code === "ENOSPC"
                ? `${message} (reason: disk_full)`
                : message,
            cause,
          }),
      });

    yield* Effect.all(
      [options.workspace, xdgData, configDirectory, xdgCache, xdgState].map((directory) =>
        fileOperation(`Failed to create ${directory}`, () => mkdir(directory, { recursive: true })),
      ),
      { concurrency: "unbounded", discard: true },
    );
    const systemPrompt = options.loadSystemPrompt ? yield* options.loadSystemPrompt() : null;
    const blender = options.loadBlenderServer ? yield* options.loadBlenderServer() : null;
    const config = createOpenCodeConfig(broker.info, systemPrompt, blender);
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
      version,
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
    const shellPath = yield* Effect.promise(loadShellPath);
    const child = yield* Effect.try({
      try: () =>
        spawn(
          prepared.executable,
          ["serve", "--port", "0", "--hostname", LOOPBACK],
          {
            cwd: prepared.workspace,
            env: {
              ...process.env,
              ...(shellPath ? { PATH: shellPath } : {}),
              ...OPENCODE_ISOLATION_ENV,
              XDG_CACHE_HOME: prepared.xdgCache,
              XDG_CONFIG_HOME: prepared.xdgConfig,
              XDG_DATA_HOME: prepared.xdgData,
              XDG_STATE_HOME: prepared.xdgState,
              OPENCODE_LOG_LEVEL: "info",
              OPENCODE_PASSWORD: prepared.password,
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
      // A copy can pass every check and still not run. An older one is worth one more try, and if
      // that runs, the newer one isn't chosen again.
      const resource = yield* awaitOpenCode(process).pipe(
        Effect.catchAll((failure) =>
          Effect.gen(function* () {
            const fallback = yield* findOpenCodeFallback(
              { cacheDirectory: options.binaryCacheDirectory },
              prepared.version,
            );
            if (!fallback) return yield* Effect.fail(failure);
            yield* stopOpenCode(process);
            const second = yield* Effect.acquireRelease(
              spawnOpenCode({ ...prepared, executable: fallback.executable }),
              stopOpenCode,
            );
            const started = yield* awaitOpenCode(second).pipe(Effect.mapError(() => failure));
            yield* distrustOpenCodeVersion(
              { cacheDirectory: options.binaryCacheDirectory },
              prepared.version,
            );
            return started;
          }),
        ),
      );
      const { pid } = resource.child;
      const { onNetstatMiss } = options;
      if (onNetstatMiss && pid !== undefined && globalThis.process.platform === "win32") {
        yield* explainNetstatMiss(pid, resource.port).pipe(
          Effect.tap((message) => {
            if (message) onNetstatMiss(new OpenCodeError({ message }));
          }),
          Effect.forkScoped,
        );
      }
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
