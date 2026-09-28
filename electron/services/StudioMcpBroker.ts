import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Context, Data, Effect, Layer, Schedule } from "effect";

import type { StudioMcpStatus } from "../../src/types/desktop";
import { studioMcpCommand, studioMcpInstallPath } from "../opencodeConfig";

const LOOPBACK = "127.0.0.1";

export class StudioMcpBrokerError extends Data.TaggedError("StudioMcpBrokerError")<{
  message: string;
  cause?: unknown;
}> {}

/** Studio's MCP helper isn't installed where Studio puts it. */
export class StudioMcpNotInstalledError extends Data.TaggedError("StudioMcpNotInstalledError")<{
  message: string;
}> {}

/** The helper started but the MCP connection failed. Carries its stderr and exit status. */
export class StudioMcpConnectError extends Data.TaggedError("StudioMcpConnectError")<{
  message: string;
  cause: unknown;
}> {}

export type StudioMcpStartFailureReason = "not_installed" | "closed";

export class StudioMcpStartFailure extends Data.TaggedError("StudioMcpStartFailure")<{
  reason: StudioMcpStartFailureReason;
  cause: unknown;
}> {}

export function classifyStudioMcpStartFailure(cause: unknown): StudioMcpStartFailureReason {
  if (cause instanceof StudioMcpNotInstalledError) return "not_installed";
  // A spawn ENOENT means the helper command itself doesn't exist.
  if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
    return "not_installed";
  }
  return "closed";
}

/**
 * Retries for Studio's MCP helper at startup: five attempts over about 30 seconds (2, 4, 8
 * and 16 seconds apart), which rides out a helper that closes while Studio updates or launches.
 */
export const studioMcpStartSchedule = Schedule.exponential("2 seconds").pipe(
  Schedule.intersect(Schedule.recurs(4)),
);

export interface StudioMcpBrokerInfo {
  url: string;
}

export interface StudioMcpUpstream {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Tool[] }>;
  onToolsChanged(listener: () => void): void;
  /** Called when the upstream connection closes on its own. */
  onClose?(listener: () => void): void;
  /** Resolves once the upstream can serve requests. The broker refuses new sessions until then. */
  ready?(): Promise<unknown>;
  status?(): StudioMcpStatus;
}

export interface StudioMcpBrokerService {
  readonly info: StudioMcpBrokerInfo;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CallToolResult, StudioMcpBrokerError>;
  readonly listTools: Effect.Effect<Tool[], StudioMcpBrokerError>;
  readonly status: Effect.Effect<StudioMcpStatus>;
}

export class StudioMcpBroker extends Context.Tag("@bloxbot/StudioMcpBroker")<
  StudioMcpBroker,
  StudioMcpBrokerService
>() {}

class SdkStudioMcpUpstream implements StudioMcpUpstream {
  private readonly client = new Client(
    { name: "BloxBot", version: "1.0.0" },
    { capabilities: {} },
  );

  private constructor() {}

  static async connect(
    command: string[],
    cwd: string,
    installPath: string | null = null,
  ): Promise<SdkStudioMcpUpstream> {
    const [executable, ...args] = command;
    if (!executable) throw new Error("Studio MCP command is empty");
    if (installPath && !(await exists(installPath))) {
      throw new StudioMcpNotInstalledError({
        message: `Studio MCP helper not found at ${installPath}`,
      });
    }
    const transport = new ObservedStdioClientTransport({
      command: executable,
      args,
      cwd,
      stderr: "pipe",
    });
    let stderrTail = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trimEnd();
      if (!message) return;
      process.stderr.write(`[studio-mcp] ${message}\n`);
      stderrTail = `${stderrTail}\n${message}`.slice(-STDERR_TAIL_LENGTH);
    });
    const upstream = new SdkStudioMcpUpstream();
    try {
      await upstream.client.connect(transport);
    } catch (cause) {
      await transport.close().catch(() => undefined);
      if (classifyStudioMcpStartFailure(cause) === "not_installed") throw cause;
      throw new StudioMcpConnectError({
        message: describeConnectFailure(cause, transport.exit, stderrTail),
        cause,
      });
    }
    return upstream;
  }

  onClose(listener: () => void): void {
    this.client.onclose = listener;
  }

  onToolsChanged(listener: () => void): void {
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, listener);
  }

  async listTools() {
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const startedAt = performance.now();
    process.stderr.write(`[studio-mcp] call ${name}\n`);
    const result = await this.client.callTool({ name, arguments: args }, CallToolResultSchema);
    const parsed = CallToolResultSchema.parse(result);
    const summary = summarizeToolResult(name, parsed);
    process.stderr.write(
      `[studio-mcp] result ${name} ${Math.round(performance.now() - startedAt)}ms${summary}\n`,
    );
    return parsed;
  }

  async close() {
    await this.client.close();
  }
}

const STDERR_TAIL_LENGTH = 300;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Keeps the helper's exit status, which the SDK drops, so start failures can report it. */
class ObservedStdioClientTransport extends StdioClientTransport {
  exit: ProcessExit | undefined;

  override async start(): Promise<void> {
    await super.start();
    const child = (this as unknown as { _process?: ChildProcess })._process;
    child?.once("exit", (code, signal) => {
      this.exit = { code, signal };
    });
  }
}

export function describeConnectFailure(
  cause: unknown,
  exit: ProcessExit | undefined,
  stderr: string,
): string {
  const details: string[] = [];
  if (exit?.code != null) details.push(`exit code ${exit.code}`);
  if (exit?.signal) details.push(`signal ${exit.signal}`);
  const trimmed = stderr.trim().replace(/\s+/g, " ");
  if (trimmed) details.push(`stderr: ${trimmed}`);
  const message = cause instanceof Error ? cause.message : String(cause);
  return details.length > 0 ? `${message} (${details.join(", ")})` : message;
}

interface StudioMcpConnectionOptions {
  /** Least time between on-demand reconnects once the startup attempts are over. */
  reconnectIntervalMs?: number;
  now?: () => number;
}

/**
 * The broker's single upstream. It connects to Studio's MCP helper, reconnects on demand if
 * the helper closes or never started, and tracks a status the renderer can show.
 */
export class StudioMcpConnection implements StudioMcpUpstream {
  private current: StudioMcpUpstream | undefined;
  private pending: Promise<StudioMcpUpstream> | undefined;
  private state: StudioMcpStatus["state"] = "starting";
  private startupFinished = false;
  private closed = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private lastError: unknown = new Error("Studio MCP is still starting");
  private readonly toolsListeners = new Set<() => void>();
  private readonly reconnectIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly connectUpstream: () => Promise<StudioMcpUpstream>,
    options: StudioMcpConnectionOptions = {},
  ) {
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  status(): StudioMcpStatus {
    return { state: this.state };
  }

  /** Makes one connection attempt, shared by everyone who asks while it runs. */
  attempt(): Promise<StudioMcpUpstream> {
    if (this.current) return Promise.resolve(this.current);
    if (this.pending) return this.pending;
    this.lastAttemptAt = this.now();
    const pending = this.connectUpstream().then(
      async (upstream) => {
        if (this.closed) {
          await upstream.close();
          throw new Error("Studio MCP connection closed");
        }
        this.current = upstream;
        this.state = "connected";
        upstream.onToolsChanged(() => {
          for (const listener of this.toolsListeners) listener();
        });
        upstream.onClose?.(() => {
          if (this.current !== upstream) return;
          this.current = undefined;
          this.lastError = new Error("Studio MCP helper closed");
          if (this.startupFinished) this.state = "unavailable";
        });
        return upstream;
      },
      (cause: unknown) => {
        this.lastError = cause;
        if (this.startupFinished) this.state = stateForFailure(cause);
        throw cause;
      },
    );
    this.pending = pending;
    pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  /** Records how the startup attempts ended. Later requests reconnect on demand. */
  finishStartup(failure: StudioMcpStartFailure | null): void {
    this.startupFinished = true;
    if (failure) this.state = failure.reason === "not_installed" ? "not_installed" : "unavailable";
    else if (this.current) this.state = "connected";
  }

  /**
   * Returns a connected upstream, or fails fast. While the startup retries run, requests join
   * an attempt in flight instead of starting their own. After that, requests reconnect at most
   * once per interval so a polling client can't spawn a helper on every call.
   */
  async ready(): Promise<StudioMcpUpstream> {
    if (this.current) return this.current;
    if (this.pending) return this.pending;
    if (this.closed || !this.startupFinished) throw this.lastError;
    if (this.now() - this.lastAttemptAt < this.reconnectIntervalMs) throw this.lastError;
    return this.attempt();
  }

  onToolsChanged(listener: () => void): void {
    this.toolsListeners.add(listener);
  }

  async listTools() {
    return (await this.ready()).listTools();
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.ready()).callTool(name, args);
  }

  async close(): Promise<void> {
    this.closed = true;
    const current = this.current;
    this.current = undefined;
    await current?.close();
  }
}

function stateForFailure(cause: unknown): StudioMcpStatus["state"] {
  return classifyStudioMcpStartFailure(cause) === "not_installed" ? "not_installed" : "unavailable";
}

export interface StudioMcpStartupOptions {
  schedule?: Schedule.Schedule<unknown, StudioMcpStartFailure>;
  /** Called once if every attempt failed for a reason worth reporting. */
  onFailure?: (error: StudioMcpBrokerError) => void;
}

/**
 * Connects to Studio's MCP helper at startup, retrying closes on a bounded schedule. A missing
 * helper isn't retried or reported, since that only means Studio isn't installed.
 */
export function runStudioMcpStartup(
  connection: StudioMcpConnection,
  options: StudioMcpStartupOptions = {},
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => connection.attempt(),
    catch: (cause) =>
      new StudioMcpStartFailure({ reason: classifyStudioMcpStartFailure(cause), cause }),
  }).pipe(
    Effect.tapError((failure) =>
      Effect.logWarning(`[studio-mcp] start attempt failed reason=${failure.reason}`),
    ),
    Effect.retry({
      schedule: options.schedule ?? studioMcpStartSchedule,
      while: (failure) => failure.reason !== "not_installed",
    }),
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => connection.finishStartup(null)),
      onFailure: (failure) =>
        Effect.sync(() => {
          connection.finishStartup(failure);
          if (failure.reason === "not_installed") return;
          options.onFailure?.(
            new StudioMcpBrokerError({
              message: "Failed to connect to Studio MCP at startup",
              cause: failure.cause,
            }),
          );
        }),
    }),
  );
}

function summarizeToolResult(name: string, result: CallToolResult): string {
  if (name !== "list_roblox_studios") return result.isError ? " error=true" : "";
  const text = result.content.find(
    (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
      part.type === "text",
  )?.text;
  if (!text) return ` error=${result.isError === true} studios=unknown`;
  try {
    const value = JSON.parse(text) as { studios?: unknown[] };
    return ` error=${result.isError === true} studios=${Array.isArray(value.studios) ? value.studios.length : "unknown"}`;
  } catch {
    return ` error=${result.isError === true} studios=unparseable`;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reject(res: ServerResponse, statusCode: number, message: string) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32_000, message }, id: null }));
}

interface BrokerResource extends StudioMcpBrokerService {
  close(): Promise<void>;
}

export async function startStudioMcpBroker(
  upstream: StudioMcpUpstream,
): Promise<BrokerResource> {
  process.stderr.write("[studio-mcp] broker starting\n");
  const sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport }
  >();
  function makeSession() {
    const server = new Server(
      { name: "bloxbot-studio-broker", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      upstream.callTool(request.params.name, request.params.arguments ?? {}),
    );
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId): void => {
        sessions.set(sessionId, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    return { server, transport };
  }

  upstream.onToolsChanged(() => {
    for (const { server } of sessions.values()) void server.sendToolListChanged();
  });

  const httpServer = createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") return reject(res, 404, "Not found");
      const sessionId = req.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      let body: unknown;
      if (req.method === "POST") body = await readJson(req);

      if (!session && req.method === "POST" && isInitializeRequest(body)) {
        try {
          await upstream.ready?.();
        } catch {
          return reject(res, 503, "Roblox Studio MCP is not available");
        }
        session = makeSession();
        await session.server.connect(session.transport);
      }
      if (!session) return reject(res, 400, "A valid MCP session is required");
      await session.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reject(res, 500, "MCP broker request failed");
    }
  });

  await new Promise<void>((resolve, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(0, LOOPBACK, () => resolve());
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Broker did not bind a TCP port");

  process.stderr.write(`[studio-mcp] broker listening on ${LOOPBACK}:${address.port}\n`);
  return {
    info: { url: `http://${LOOPBACK}:${address.port}/mcp` },
    callTool: (name, args) =>
      Effect.tryPromise({
        try: () => upstream.callTool(name, args),
        catch: (cause) => new StudioMcpBrokerError({ message: "Studio MCP call failed", cause }),
      }),
    listTools: Effect.tryPromise({
      try: async () => (await upstream.listTools()).tools,
      catch: (cause) =>
        new StudioMcpBrokerError({ message: "Studio MCP tool list failed", cause }),
    }),
    status: Effect.sync(() => upstream.status?.() ?? { state: "connected" }),
    close: async () => {
      for (const { server } of sessions.values()) await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await upstream.close();
    },
  };
}

export interface StudioMcpBrokerOptions {
  workspace: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  comSpec?: string;
  systemRoot?: string;
  /** Called once when the startup attempts fail for a reason worth reporting. */
  onStartFailure?: (error: StudioMcpBrokerError) => void;
  startSchedule?: Schedule.Schedule<unknown, StudioMcpStartFailure>;
}

export function makeStudioMcpBrokerLayer(options: StudioMcpBrokerOptions) {
  const platform = options.platform ?? process.platform;
  const environment = {
    localAppData: options.localAppData,
    comSpec: options.comSpec,
    systemRoot: options.systemRoot,
  };
  return Layer.scoped(
    StudioMcpBroker,
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(options.workspace, { recursive: true }),
        catch: (cause) =>
          new StudioMcpBrokerError({ message: "Failed to create the BloxBot workspace", cause }),
      });
      const connection = new StudioMcpConnection(() =>
        SdkStudioMcpUpstream.connect(
          studioMcpCommand(platform, environment),
          options.workspace,
          studioMcpInstallPath(platform, environment),
        ),
      );
      // The broker starts without Studio so the rest of the app works while Studio is set up.
      const broker = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => startStudioMcpBroker(connection),
          catch: (cause) =>
            new StudioMcpBrokerError({ message: "Failed to start Studio MCP broker", cause }),
        }),
        (resource) => Effect.promise(() => resource.close()),
      );
      yield* runStudioMcpStartup(connection, {
        schedule: options.startSchedule,
        onFailure: options.onStartFailure,
      }).pipe(Effect.forkScoped);
      return broker;
    }),
  );
}
