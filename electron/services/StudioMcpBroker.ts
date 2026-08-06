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
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Context, Data, Effect, Layer } from "effect";

import { studioMcpCommand } from "../opencodeConfig";

const LOOPBACK = "127.0.0.1";

export class StudioMcpBrokerError extends Data.TaggedError("StudioMcpBrokerError")<{
  message: string;
  cause?: unknown;
}> {}

export interface StudioMcpBrokerInfo {
  url: string;
}

export interface StudioMcpUpstream {
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Tool[] }>;
  onToolsChanged(listener: () => void): void;
}

export interface StudioMcpBrokerService {
  readonly info: StudioMcpBrokerInfo;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CallToolResult, StudioMcpBrokerError>;
}

export class StudioMcpBroker extends Context.Tag("@bloxbot/StudioMcpBroker")<
  StudioMcpBroker,
  StudioMcpBrokerService
>() {}

class SdkStudioMcpUpstream implements StudioMcpUpstream {
  private readonly client = new Client(
    { name: "bloxbot-studio-broker", version: "1.0.0" },
    { capabilities: {} },
  );

  private constructor() {}

  static async connect(command: string[], cwd: string): Promise<SdkStudioMcpUpstream> {
    const [executable, ...args] = command;
    if (!executable) throw new Error("Studio MCP command is empty");
    const transport = new StdioClientTransport({
      command: executable,
      args,
      cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const message = chunk.toString().trimEnd();
      if (message) process.stderr.write(`[studio-mcp] ${message}\n`);
    });
    const upstream = new SdkStudioMcpUpstream();
    await upstream.client.connect(transport);
    return upstream;
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
}

export function makeStudioMcpBrokerLayer(options: StudioMcpBrokerOptions) {
  return Layer.scoped(
    StudioMcpBroker,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const upstream = await SdkStudioMcpUpstream.connect(
            studioMcpCommand(options.platform ?? process.platform, {
              localAppData: options.localAppData,
              comSpec: options.comSpec,
              systemRoot: options.systemRoot,
            }),
            options.workspace,
          );
          return startStudioMcpBroker(upstream);
        },
        catch: (cause) =>
          new StudioMcpBrokerError({ message: "Failed to start Studio MCP broker", cause }),
      }),
      (resource) => Effect.promise(() => resource.close()),
    ),
  );
}
