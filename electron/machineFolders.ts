import { existsSync, mkdirSync, renameSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Where BloxBot keeps what it downloads for this computer: the engine and Blender's tools. On
 * Windows that's %LOCALAPPDATA%, which stays on this machine. Electron's userData is in
 * %APPDATA%, which roaming profiles copy at every sign-in, and these downloads run to gigabytes.
 * Other platforms keep userData, which doesn't roam.
 */
export interface MachineFolderOptions {
  platform: NodeJS.Platform;
  /** Electron's userData folder, where earlier versions kept these. */
  userData: string;
  localAppData: string | undefined;
}

/** The file system calls these make, so tests can fake them. */
export interface MachineFolderFileSystem {
  exists(path: string): boolean;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
}

const nodeFileSystem: MachineFolderFileSystem = {
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
};

const pathsFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The folder for name on this computer, or null where userData is already the right place. */
function machineFolder({ platform, localAppData }: MachineFolderOptions, name: string) {
  return platform === "win32" && localAppData ? win32.join(localAppData, "bloxbot", name) : null;
}

/**
 * The engine's folder. A copy an earlier version downloaded to userData is moved over once, so it
 * isn't downloaded again. If it can't be moved, as when antivirus holds a file or the folders are
 * on different drives, it is used where it is.
 */
export function engineFolder(
  options: MachineFolderOptions,
  fileSystem: MachineFolderFileSystem = nodeFileSystem,
): string {
  const old = pathsFor(options.platform).join(options.userData, "opencode");
  const next = machineFolder(options, "opencode");
  if (!next || fileSystem.exists(next) || !fileSystem.exists(old)) return next ?? old;
  try {
    fileSystem.mkdir(win32.dirname(next));
    fileSystem.rename(old, next);
    return next;
  } catch {
    return old;
  }
}

/**
 * Blender's tools folder. These hold a Python environment with its own path written into it, so
 * one already set up stays where it is; new setups go to this computer's folder.
 */
export function blenderToolsFolder(
  options: MachineFolderOptions,
  fileSystem: MachineFolderFileSystem = nodeFileSystem,
): string {
  const old = pathsFor(options.platform).join(options.userData, "blender-tools");
  const next = machineFolder(options, "blender-tools");
  return !next || fileSystem.exists(old) ? old : next;
}
