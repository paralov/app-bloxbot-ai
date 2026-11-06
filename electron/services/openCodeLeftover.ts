import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, win32 } from "node:path";

/**
 * OpenCode keeps its chats in one SQLite database, and a second OpenCode on it fails to start
 * with "database is locked". BloxBot stops its own OpenCode when it quits, but not when it
 * crashes or is ended from Task Manager, and on Windows that OpenCode keeps running. So the
 * running one's process ID is kept in a file, and a new start first stops one left behind.
 */

/** What a process lookup needs, so tests can fake it. */
export interface ProcessTable {
  /** The file name of the program a process runs, or null when it isn't running. */
  name(pid: number): Promise<string | null>;
  alive(pid: number): boolean;
  kill(pid: number): void;
}

const LOOKUP_TIMEOUT_MS = 5_000;

function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

/** The image name in `tasklist /FO CSV /NH` output, or null for its "no tasks" line. */
export function parseTasklistName(output: string): string | null {
  return /^\s*"([^"]+)","\d+"/m.exec(output)?.[1] ?? null;
}

export const systemProcessTable: ProcessTable = {
  async name(pid) {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const tasklist = win32.join(systemRoot, "System32", "tasklist.exe");
      const output = await run(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return output ? parseTasklistName(output) : null;
    }
    const output = (await run("ps", ["-p", String(pid), "-o", "comm="]))?.trim();
    return output ? basename(output) : null;
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (cause) {
      // EPERM means it's there but belongs to someone else.
      return (cause as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill(pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what we wanted.
    }
  },
};

interface Recorded {
  pid: number;
  name: string;
}

async function readRecorded(file: string): Promise<Recorded | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<Recorded>;
    return Number.isSafeInteger(value.pid) && typeof value.name === "string"
      ? { pid: value.pid as number, name: value.name }
      : null;
  } catch {
    return null;
  }
}

/** Notes the OpenCode now running. A failure only costs the cleanup after a crash. */
export async function recordOpenCodeProcess(
  file: string,
  pid: number,
  executable: string,
): Promise<void> {
  // win32's basename splits on both kinds of slash, so it does for every platform.
  const name = win32.basename(executable);
  await writeFile(file, JSON.stringify({ pid, name })).catch(() => undefined);
}

/** Forgets an OpenCode that has stopped, unless a newer one has been noted since. */
export async function forgetOpenCodeProcess(file: string, pid: number): Promise<void> {
  if ((await readRecorded(file))?.pid !== pid) return;
  await rm(file, { force: true }).catch(() => undefined);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stops the OpenCode an earlier run left behind and waits until it has gone, as only then is the
 * database free. Returns its process ID, or null when there was none. A process that has since
 * taken the same ID is left alone, since its program name won't match.
 */
export async function stopLeftoverOpenCode(
  file: string,
  table: ProcessTable = systemProcessTable,
  timeoutMs = 5_000,
): Promise<number | null> {
  const recorded = await readRecorded(file);
  if (!recorded || recorded.pid === process.pid) return null;
  const name = await table.name(recorded.pid);
  if (!name || name.toLowerCase() !== recorded.name.toLowerCase()) {
    await rm(file, { force: true }).catch(() => undefined);
    return null;
  }
  table.kill(recorded.pid);
  const deadline = Date.now() + timeoutMs;
  while (table.alive(recorded.pid) && Date.now() < deadline) await sleep(100);
  await rm(file, { force: true }).catch(() => undefined);
  return recorded.pid;
}
