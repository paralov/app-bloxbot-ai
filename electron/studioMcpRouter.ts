import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcID = number | string | null;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcID;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface PendingToolCall {
  internalID: string;
  original: JsonRpcMessage;
}

const CONTROL_TOOLS = new Set(["list_roblox_studios", "set_active_studio"]);
const INTERNAL_REQUEST_PREFIX = "bloxbot-select-";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function idKey(id: JsonRpcID): string {
  return `${typeof id}:${String(id)}`;
}

function toolName(message: JsonRpcMessage): string | null {
  const params = asRecord(message.params);
  return typeof params?.name === "string" ? params.name : null;
}

function selectionFailed(message: JsonRpcMessage): boolean {
  if (message.error !== undefined) return true;
  return asRecord(message.result)?.isError === true;
}

function filterControlTools(message: JsonRpcMessage): JsonRpcMessage {
  const result = asRecord(message.result);
  if (!Array.isArray(result?.tools)) return message;

  return {
    ...message,
    result: {
      ...result,
      tools: result.tools.filter((tool) => {
        const name = asRecord(tool)?.name;
        return typeof name !== "string" || !CONTROL_TOOLS.has(name);
      }),
    },
  };
}

export class StudioMcpRouter {
  private nextInternalID = 0;
  private readonly pendingToolCalls = new Map<string, PendingToolCall>();
  private readonly pendingToolCallsByOriginalID = new Map<string, string>();
  private readonly toolListRequests = new Set<string>();

  constructor(
    private readonly studioID: string,
    private readonly writeToStudio: (message: JsonRpcMessage) => void,
    private readonly writeToClient: (message: JsonRpcMessage) => void,
  ) {}

  handleClientMessage(message: JsonRpcMessage): void {
    if (message.method === "notifications/cancelled") {
      const params = asRecord(message.params);
      const requestID = params?.requestId;
      if (typeof requestID === "string" || typeof requestID === "number" || requestID === null) {
        const internalKey = this.pendingToolCallsByOriginalID.get(idKey(requestID));
        const pending = internalKey ? this.pendingToolCalls.get(internalKey) : undefined;
        if (internalKey && pending) {
          this.pendingToolCalls.delete(internalKey);
          this.pendingToolCallsByOriginalID.delete(idKey(requestID));
          this.writeToStudio({
            ...message,
            params: { ...params, requestId: pending.internalID },
          });
          return;
        }
      }
    }

    if (message.method === "tools/list" && message.id !== undefined) {
      this.toolListRequests.add(idKey(message.id));
      this.writeToStudio(message);
      return;
    }

    if (message.method !== "tools/call") {
      this.writeToStudio(message);
      return;
    }

    if (toolName(message) === "set_active_studio") {
      const params = asRecord(message.params) ?? {};
      this.writeToStudio({
        ...message,
        params: {
          ...params,
          arguments: { studio_id: this.studioID },
        },
      });
      return;
    }

    const internalID = `${INTERNAL_REQUEST_PREFIX}${++this.nextInternalID}`;
    const internalKey = idKey(internalID);
    this.pendingToolCalls.set(internalKey, { internalID, original: message });
    if (message.id !== undefined) {
      this.pendingToolCallsByOriginalID.set(idKey(message.id), internalKey);
    }
    this.writeToStudio({
      jsonrpc: "2.0",
      id: internalID,
      method: "tools/call",
      params: {
        name: "set_active_studio",
        arguments: { studio_id: this.studioID },
      },
    });
  }

  handleStudioMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined) {
      const key = idKey(message.id);
      const pending = this.pendingToolCalls.get(key);
      if (pending) {
        this.pendingToolCalls.delete(key);
        if (pending.original.id !== undefined) {
          this.pendingToolCallsByOriginalID.delete(idKey(pending.original.id));
        }
        if (selectionFailed(message)) {
          if (pending.original.id !== undefined) {
            this.writeToClient({ ...message, id: pending.original.id });
          }
        } else {
          this.writeToStudio(pending.original);
        }
        return;
      }

      if (this.toolListRequests.delete(key)) {
        this.writeToClient(filterControlTools(message));
        return;
      }

      if (typeof message.id === "string" && message.id.startsWith(INTERNAL_REQUEST_PREFIX)) return;
    }

    this.writeToClient(message);
  }
}

function parseArguments(argv: readonly string[]): { studioID: string; command: string[] } {
  const separator = argv.indexOf("--");
  const studioFlag = argv.indexOf("--studio-id");
  const studioID = studioFlag >= 0 ? argv[studioFlag + 1] : undefined;
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  if (!studioID || command.length === 0) {
    throw new Error("Usage: studioMcpRouter --studio-id <id> -- <StudioMCP command>");
  }
  return { studioID, command };
}

export function runStudioMcpRouter(argv = process.argv.slice(2)): void {
  const { studioID, command } = parseArguments(argv);
  const [executable, ...args] = command;
  if (!executable) throw new Error("StudioMCP command is unavailable");

  const {
    BLOXBOT_STUDIO_ROUTER_ENTRY: _routerEntry,
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    ...childEnvironment
  } = process.env;
  const child = spawn(executable, args, {
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const sendLine = (stream: NodeJS.WritableStream, message: JsonRpcMessage) => {
    stream.write(`${JSON.stringify(message)}\n`);
  };
  const router = new StudioMcpRouter(
    studioID,
    (message) => sendLine(child.stdin, message),
    (message) => sendLine(process.stdout, message),
  );

  const clientInput = createInterface({ input: process.stdin });
  const studioOutput = createInterface({ input: child.stdout });
  let finished = false;
  const finish = (code: number) => {
    if (finished) return;
    finished = true;
    clientInput.close();
    studioOutput.close();
    process.stdin.pause();
    process.exitCode = code;
  };
  clientInput.on("line", (line) => {
    try {
      router.handleClientMessage(JSON.parse(line) as JsonRpcMessage);
    } catch (error) {
      process.stderr.write(`BloxBot Studio router ignored invalid client JSON: ${String(error)}\n`);
    }
  });
  studioOutput.on("line", (line) => {
    try {
      router.handleStudioMessage(JSON.parse(line) as JsonRpcMessage);
    } catch (error) {
      process.stderr.write(`BloxBot Studio router ignored invalid StudioMCP JSON: ${String(error)}\n`);
    }
  });
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", (error) => {
    process.stderr.write(`BloxBot Studio router input failed: ${error.message}\n`);
  });
  child.on("error", (error) => {
    process.stderr.write(`BloxBot Studio router failed to start StudioMCP: ${error.message}\n`);
    finish(1);
  });
  child.on("exit", (code) => {
    finish(code ?? 1);
  });
  process.stdin.on("close", () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  }
}

if (process.env.BLOXBOT_STUDIO_ROUTER_ENTRY === "1") {
  try {
    runStudioMcpRouter();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
