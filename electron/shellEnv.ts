import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

const TIMEOUT_MS = 5000;

function userShell(): string {
  try {
    const login = userInfo().shell;
    return process.env.SHELL || (login && login !== "unknown" ? login : "/bin/sh");
  } catch {
    return process.env.SHELL || "/bin/sh";
  }
}

export function parseShellEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of output.split("\0")) {
    const separator = line.indexOf("=");
    // Text printed by the shell's startup files ends up before the first variable.
    const start = line.lastIndexOf("\n", separator) + 1;
    if (separator > start) env[line.slice(start, separator)] = line.slice(separator + 1);
  }
  return env;
}

function probe(shell: string, mode: "-il" | "-l"): Promise<Record<string, string> | "timeout" | null> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      [mode, "-c", "env -0"],
      { timeout: TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(error.killed ? "timeout" : null);
          return;
        }
        const env = parseShellEnv(stdout);
        resolve(Object.keys(env).length > 0 ? env : null);
      },
    );
    // Nothing to read, as an interactive shell could otherwise wait on it.
    child.stdin?.end();
  });
}

/**
 * The user's shell environment, loaded the way OpenCode's desktop app loads it. Apps opened from the
 * Finder don't get it, and OpenCode looks for tools like Claude Code on PATH.
 */
export async function loadShellEnv(): Promise<Record<string, string>> {
  if (process.platform === "win32") return {};
  const shell = userShell();
  if (basename(shell).toLowerCase() === "nu") return {};
  const interactive = await probe(shell, "-il");
  if (interactive === "timeout") return {};
  if (interactive) return interactive;
  const login = await probe(shell, "-l");
  return login && login !== "timeout" ? login : {};
}
