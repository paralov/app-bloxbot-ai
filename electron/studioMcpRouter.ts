import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRpcID = number | string | null;
type JsonRpcMessage = {
  id?: JsonRpcID;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

const SELECT_ID = "__bloxbot_select_studio__";
const CONTROL_TOOLS = new Set(["list_roblox_studios", "set_active_studio"]);

const record = (value: unknown) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
const key = (id: JsonRpcID) => `${typeof id}:${String(id)}`;

function selectionFailed(message: JsonRpcMessage): boolean {
  return message.error !== undefined || record(message.result)?.isError === true;
}

function hideControlTools(message: JsonRpcMessage): JsonRpcMessage {
  const result = record(message.result);
  if (!Array.isArray(result?.tools)) return message;
  return {
    ...message,
    result: {
      ...result,
      tools: result.tools.filter((tool) => !CONTROL_TOOLS.has(String(record(tool)?.name))),
    },
  };
}

export class StudioMcpRouter {
  private selected = false;
  private readonly waitingToolLists: JsonRpcMessage[] = [];
  private readonly toolListIDs = new Set<string>();

  constructor(
    private readonly studioID: string,
    private readonly toStudio: (message: JsonRpcMessage) => void,
    private readonly toClient: (message: JsonRpcMessage) => void,
    private readonly fail: (message: string) => void,
  ) {}

  handleClient(message: JsonRpcMessage): void {
    if (message.method === "notifications/initialized") {
      this.toStudio(message);
      this.toStudio({
        jsonrpc: "2.0",
        id: SELECT_ID,
        method: "tools/call",
        params: { name: "set_active_studio", arguments: { studio_id: this.studioID } },
      });
      return;
    }

    if (message.method === "tools/list" && message.id !== undefined) {
      this.toolListIDs.add(key(message.id));
      if (!this.selected) {
        this.waitingToolLists.push(message);
        return;
      }
    }
    this.toStudio(message);
  }

  handleStudio(message: JsonRpcMessage): void {
    if (message.id === SELECT_ID) {
      if (selectionFailed(message)) {
        this.fail("StudioMCP could not select the assigned place");
        return;
      }
      this.selected = true;
      for (const request of this.waitingToolLists.splice(0)) this.toStudio(request);
      return;
    }

    if (message.id !== undefined && this.toolListIDs.delete(key(message.id))) {
      this.toClient(hideControlTools(message));
      return;
    }
    this.toClient(message);
  }
}

function run(): void {
  const separator = process.argv.indexOf("--");
  const studioFlag = process.argv.indexOf("--studio-id");
  const studioID = studioFlag >= 0 ? process.argv[studioFlag + 1] : undefined;
  const [executable, ...args] = separator >= 0 ? process.argv.slice(separator + 1) : [];
  if (!studioID || !executable) throw new Error("Missing Studio router arguments");

  const { ELECTRON_RUN_AS_NODE: _, BLOXBOT_STUDIO_ROUTER_ENTRY: __, ...env } = process.env;
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const write = (stream: NodeJS.WritableStream, message: JsonRpcMessage) =>
    stream.write(`${JSON.stringify(message)}\n`);
  const finish = (code: number) => {
    process.exitCode = code;
    process.stdin.pause();
  };
  const router = new StudioMcpRouter(
    studioID,
    (message) => write(child.stdin, message),
    (message) => write(process.stdout, message),
    (message) => {
      process.stderr.write(`${message}\n`);
      child.kill("SIGTERM");
      finish(1);
    },
  );

  const relay = (line: string, handler: (message: JsonRpcMessage) => void) => {
    try {
      handler(JSON.parse(line) as JsonRpcMessage);
    } catch (error) {
      process.stderr.write(`${String(error)}\n`);
    }
  };
  createInterface({ input: process.stdin }).on("line", (line) =>
    relay(line, (message) => router.handleClient(message)),
  );
  createInterface({ input: child.stdout }).on("line", (line) =>
    relay(line, (message) => router.handleStudio(message)),
  );
  child.stderr.pipe(process.stderr);
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    finish(1);
  });
  child.on("exit", (code) => finish(code ?? 1));
  process.stdin.on("close", () => child.kill("SIGTERM"));
}

if (process.env.BLOXBOT_STUDIO_ROUTER_ENTRY === "1") run();
