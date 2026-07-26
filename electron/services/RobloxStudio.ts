import { spawn } from "node:child_process";

import type { RobloxStudioPlace } from "../../src/types/desktop";

const REQUEST_TIMEOUT_MS = 5_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function parseStudioListResult(result: unknown): RobloxStudioPlace[] {
  const resultRecord = asRecord(result);
  const content = resultRecord?.content;
  if (!Array.isArray(content)) throw new Error("StudioMCP returned an invalid place list");

  const textItem = content.find((item) => asRecord(item)?.type === "text");
  const text = asRecord(textItem)?.text;
  if (typeof text !== "string") throw new Error("StudioMCP did not return a place list");

  const payload = asRecord(JSON.parse(text));
  if (!Array.isArray(payload?.studios)) throw new Error("StudioMCP returned an invalid place list");

  return payload.studios.flatMap((studio) => {
    const candidate = asRecord(studio);
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.name !== "string") {
      return [];
    }
    return [
      {
        id: candidate.id,
        name: candidate.name,
        active: candidate.active === true,
      },
    ];
  });
}

export function listRobloxStudios(command: readonly string[]): Promise<RobloxStudioPlace[]> {
  const [executable, ...args] = command;
  if (!executable) return Promise.reject(new Error("StudioMCP command is unavailable"));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (child.exitCode === null && child.pid !== undefined) child.kill("SIGTERM");
      operation();
    };

    const fail = (message: string) =>
      finish(() => reject(new Error(stderr.trim() ? `${message}: ${stderr.trim()}` : message)));

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleResponse = (response: JsonRpcResponse) => {
      if (response.id === 1) {
        if (response.error) {
          fail(response.error.message ?? "StudioMCP initialization failed");
          return;
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_roblox_studios", arguments: {} },
        });
        return;
      }

      if (response.id === 2) {
        if (response.error) {
          fail(response.error.message ?? "StudioMCP could not list places");
          return;
        }
        try {
          const studios = parseStudioListResult(response.result);
          finish(() => resolve(studios));
        } catch (error) {
          fail(error instanceof Error ? error.message : "StudioMCP returned an invalid place list");
        }
      }
    };

    const timer = setTimeout(() => fail("StudioMCP timed out while listing places"), REQUEST_TIMEOUT_MS);

    child.on("error", (error) => fail(`Failed to start StudioMCP: ${error.message}`));
    child.on("exit", (code) => {
      if (!settled) fail(`StudioMCP exited before listing places (code ${code ?? "unknown"})`);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      let newlineIndex = stdout.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        if (line) {
          try {
            handleResponse(JSON.parse(line) as JsonRpcResponse);
          } catch {
            // Ignore non-JSON logging on stdout and continue waiting for the response.
          }
        }
        newlineIndex = stdout.indexOf("\n");
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "BloxBot", version: "1" },
      },
    });
  });
}
