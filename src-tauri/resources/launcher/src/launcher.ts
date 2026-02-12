#!/usr/bin/env node
/**
 * MCP Server Launcher
 *
 * A thin wrapper around the robloxstudio-mcp server that:
 * 1. Proxies stdin/stdout so the MCP stdio protocol works transparently
 * 2. Exposes a tiny HTTP control endpoint so the Rust backend can
 *    reliably shut down the MCP server process tree
 *
 * Environment variables (passed through to the child):
 *   ROBLOX_STUDIO_HOST   - host for the Studio plugin bridge
 *   ROBLOX_STUDIO_PORT   - port for the Studio plugin bridge
 *   BLOXBOT_CONTROL_PORT - port for the launcher control endpoint
 *                          (defaults to ROBLOX_STUDIO_PORT + 100)
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// The MCP server entry point lives in the sibling mcp-server submodule
const ENTRY = join(__dirname, "..", "..", "mcp-server", "dist", "index.js");

const STUDIO_PORT = parseInt(process.env.ROBLOX_STUDIO_PORT ?? "3002", 10);
const CONTROL_PORT = parseInt(
  process.env.BLOXBOT_CONTROL_PORT ?? String(STUDIO_PORT + 100),
  10,
);

// ── Spawn the real MCP server ──────────────────────────────────────────

const child: ChildProcess = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "inherit"], // stdin/stdout piped, stderr inherited
  env: process.env,
});

// Proxy stdin -> child stdin (MCP protocol messages from OpenCode)
process.stdin.pipe(child.stdin!);

// Proxy child stdout -> stdout (MCP protocol responses to OpenCode)
child.stdout!.pipe(process.stdout);

// If the child exits, we exit with the same code
child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  controlServer.close();
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

// Forward termination signals to the child
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    child.kill(sig);
  });
}

// ── Control HTTP server ────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // POST /shutdown - gracefully kill the child and exit
  if (req.method === "POST" && req.url === "/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    child.kill("SIGTERM");
    // Force-kill after 2s if still alive
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      process.exit(0);
    }, 2000);
    return;
  }

  // GET /health - check if the child is still alive
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        pid: child.pid,
        childAlive: !child.killed && child.exitCode === null,
      }),
    );
    return;
  }

  res.writeHead(404);
  res.end();
}

const controlServer = createServer(handleRequest);

// Handle EADDRINUSE and other listen errors gracefully.
// If the control port is already in use (e.g. stale process from a previous
// session), log the error but don't crash — the MCP server can still function
// without the control endpoint (shutdown will rely on process signals instead).
controlServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[launcher] Control port ${CONTROL_PORT} already in use. ` +
        `Control endpoint unavailable — shutdown will rely on signals.`,
    );
  } else {
    console.error(`[launcher] Control server error: ${err.message}`);
  }
});

controlServer.listen(CONTROL_PORT, "127.0.0.1", () => {
  // Log to stderr so it shows in OpenCode's MCP stderr logs
  // but doesn't interfere with the stdio MCP protocol on stdout
  console.error(`[launcher] Control endpoint on 127.0.0.1:${CONTROL_PORT}`);
});
