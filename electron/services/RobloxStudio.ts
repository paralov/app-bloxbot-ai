import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { RobloxStudioPlace } from "../../src/types/desktop";

const TIMEOUT_MS = 5_000;

type Response = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

const record = (value: unknown) =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;

export function parseStudioListResult(result: unknown): RobloxStudioPlace[] {
  const content = record(result)?.content;
  if (!Array.isArray(content)) throw new Error("StudioMCP returned an invalid place list");
  const text = record(content.find((item) => record(item)?.type === "text"))?.text;
  if (typeof text !== "string") throw new Error("StudioMCP did not return a place list");
  const studios = record(JSON.parse(text))?.studios;
  if (!Array.isArray(studios)) throw new Error("StudioMCP returned an invalid place list");

  return studios.flatMap((studio) => {
    const place = record(studio);
    return place && typeof place.id === "string" && typeof place.name === "string"
      ? [{ id: place.id, name: place.name, active: place.active === true }]
      : [];
  });
}

export function listRobloxStudios(command: readonly string[]): Promise<RobloxStudioPlace[]> {
  const [executable, ...args] = command;
  if (!executable) return Promise.reject(new Error("StudioMCP command is unavailable"));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;

    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (child.exitCode === null) child.kill("SIGTERM");
      result();
    };
    const fail = (message: string) =>
      finish(() => reject(new Error(stderr.trim() ? `${message}: ${stderr.trim()}` : message)));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

    lines.on("line", (line) => {
      let response: Response;
      try {
        response = JSON.parse(line) as Response;
      } catch {
        return;
      }
      if (response.id === 1) {
        if (response.error) return fail(response.error.message ?? "StudioMCP initialization failed");
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_roblox_studios", arguments: {} },
        });
      }
      if (response.id === 2) {
        if (response.error) return fail(response.error.message ?? "StudioMCP could not list places");
        try {
          const places = parseStudioListResult(response.result);
          finish(() => resolve(places));
        } catch (error) {
          fail(error instanceof Error ? error.message : "StudioMCP returned an invalid place list");
        }
      }
    });

    const timer = setTimeout(() => fail("StudioMCP timed out while listing places"), TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.stdin.on("error", (error) => fail(`StudioMCP input failed: ${error.message}`));
    child.on("error", (error) => fail(`Failed to start StudioMCP: ${error.message}`));
    child.on("exit", (code) => {
      if (!settled) fail(`StudioMCP exited before listing places (code ${code ?? "unknown"})`);
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "BloxBot", version: "1" },
      },
    });
  });
}
