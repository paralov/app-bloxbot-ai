import { mkdir, rename, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/** The file system calls {@link ensureFolder} makes, so tests can fake them. */
export interface FolderFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  /** Whether the path is a directory, or null when nothing is there. */
  isDirectory(path: string): Promise<boolean | null>;
}

const nodeFolderFileSystem: FolderFileSystem = {
  mkdir,
  rename,
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return null;
    }
  },
};

/** What mkdir says when a file sits where a folder should be, or on the way to it. */
const FILE_IN_THE_WAY_CODES = new Set(["ENOTDIR", "EEXIST"]);

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

/** A timestamp that is safe in a Windows file name, e.g. 2026-11-06T10-00-00-000Z. */
function fileNameTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** The first path from root down to folder that is a file, or null if there is none. */
async function findFileInTheWay(
  root: string,
  folder: string,
  fileSystem: FolderFileSystem,
): Promise<string | null> {
  const inside = relative(root, folder);
  if (inside.startsWith("..") || isAbsolute(inside)) return null;
  let current = root;
  for (const part of ["", ...inside.split(sep).filter(Boolean)]) {
    current = part ? join(current, part) : current;
    const directory = await fileSystem.isDirectory(current);
    if (directory === null) return null;
    if (!directory) return current;
  }
  return null;
}

/** The backup name, or the first free one with a counter, as a rename would replace a file there. */
async function freeBackupName(name: string, fileSystem: FolderFileSystem): Promise<string> {
  let candidate = name;
  for (let n = 1; (await fileSystem.isDirectory(candidate)) !== null; n++) {
    candidate = `${name}-${n}`;
  }
  return candidate;
}

/**
 * Creates a folder under root. A file sitting where the folder, or one on the way to it, should
 * be is moved aside to `<name>.bak-<timestamp>` first, and the new name is returned so it can be
 * logged. Nothing above root is ever moved.
 */
export async function ensureFolder(
  root: string,
  folder: string,
  fileSystem: FolderFileSystem = nodeFolderFileSystem,
  now: () => Date = () => new Date(),
): Promise<string | null> {
  try {
    await fileSystem.mkdir(folder, { recursive: true });
    return null;
  } catch (cause) {
    const code = errorCode(cause);
    if (!code || !FILE_IN_THE_WAY_CODES.has(code)) throw cause;
    const file = await findFileInTheWay(root, folder, fileSystem);
    if (!file) throw cause;
    const movedTo = await freeBackupName(`${file}.bak-${fileNameTimestamp(now())}`, fileSystem);
    await fileSystem.rename(file, movedTo);
    await fileSystem.mkdir(folder, { recursive: true });
    return movedTo;
  }
}

/** Security software, school or work policies and Controlled folder access refuse with these. */
const BLOCKED_CODES = new Set(["EPERM", "EACCES"]);

/**
 * The `(reason: …)` for a failed workspace write that someone can act on, or null. The startup
 * screen turns it into steps to take.
 */
export function workspaceFailureReason(cause: unknown): "disk_full" | "folder_blocked" | null {
  const code = errorCode(cause);
  if (code === "ENOSPC") return "disk_full";
  if (code && BLOCKED_CODES.has(code)) return "folder_blocked";
  return null;
}
