import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { win32 } from "node:path";

import { scrubErrorText } from "../src/lib/errorReporting";
import {
  studioMcpCommand,
  studioMcpInstallPath,
  type StudioMcpWindowsEnvironment,
} from "./opencodeConfig";

/**
 * Where the Windows helper came from. Reported with startup failures, so it never holds a path.
 * - bat_path: the StudioMCP.exe named in Studio's mcp.bat
 * - registry: next to the ContentFolder Studio records in the registry
 * - versions_scan: the newest StudioMCP.exe under Roblox\Versions
 * - studio_folder: StudioMCP.exe in the newer %LOCALAPPDATA%\Roblox Studio install folder
 * - missing: Studio's mcp.bat is there but no StudioMCP.exe is. The bat isn't run, since its
 *   version path is stale by then and it can only fail.
 */
export type StudioMcpHelperSource =
  | "bat_path"
  | "registry"
  | "versions_scan"
  | "studio_folder"
  | "missing";

export interface StudioMcpHelper {
  command: string[];
  /** The file that must exist for the helper to start, or null when it is looked up on PATH. */
  installPath: string | null;
  /** How the Windows helper was found. Null on other platforms. */
  source: StudioMcpHelperSource | null;
  /** When the helper is missing: where it was looked for, with home folders shown as `~`. */
  searched?: string[];
}

/** The file system and registry reads the resolver needs, so tests can fake them. */
export interface StudioMcpHelperProbe {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  listDirectory(path: string): Promise<string[]>;
  modifiedTime(path: string): Promise<number | null>;
  /** The output of `reg query HKCU\Software\Roblox\RobloxStudio /v ContentFolder`, or null. */
  queryContentFolder(environment: StudioMcpWindowsEnvironment): Promise<string | null>;
}

const REGISTRY_TIMEOUT_MS = 3_000;
const STUDIO_REGISTRY_KEY = "HKEY_CURRENT_USER\\Software\\Roblox\\RobloxStudio";

export const nodeStudioMcpHelperProbe: StudioMcpHelperProbe = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async listDirectory(path) {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
  async modifiedTime(path) {
    try {
      const info = await stat(path);
      return info.isFile() ? info.mtimeMs : null;
    } catch {
      return null;
    }
  },
  queryContentFolder(environment) {
    const systemRoot = environment.systemRoot ?? "C:\\Windows";
    const reg = win32.join(systemRoot, "System32", "reg.exe");
    return new Promise((resolve) => {
      try {
        execFile(
          reg,
          ["query", STUDIO_REGISTRY_KEY, "/v", "ContentFolder"],
          { timeout: REGISTRY_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
          (error, stdout) => resolve(error ? null : stdout),
        );
      } catch {
        resolve(null);
      }
    });
  },
};

/**
 * The StudioMCP.exe path in mcp.bat's first `if exist "..."` line. Studio can write it as
 * `<version>\content\/..\StudioMCP.exe`, so it comes back normalised to `<version>\StudioMCP.exe`.
 */
export function parseStudioMcpBatPath(bat: string): string | null {
  const match = /^\s*if\s+exist\s+"([^"\r\n]+)"/im.exec(bat);
  const path = match?.[1]?.trim();
  return path ? win32.normalize(path) : null;
}

/** The Roblox\Versions folder holding a `version-xxx` folder, or null for any other folder. */
function versionsFolderOf(versionFolder: string): string | null {
  return /^version-/i.test(win32.basename(versionFolder)) ? win32.dirname(versionFolder) : null;
}

/** The ContentFolder value from `reg query` output. */
export function parseContentFolder(output: string): string | null {
  const match = /^\s*ContentFolder\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(output);
  return match?.[1] || null;
}

/**
 * Finds Studio's MCP helper. On Windows it starts StudioMCP.exe directly, because the mcp.bat
 * Studio writes has invalid batch syntax that fails once its hard-coded version path is stale.
 * That bat is never run: with no StudioMCP.exe found, the helper comes back as "missing".
 * Resolved on every connect attempt, so a Studio update between attempts is picked up.
 */
export async function resolveStudioMcpHelper(
  platform: NodeJS.Platform,
  environment: StudioMcpWindowsEnvironment = {},
  probe: StudioMcpHelperProbe = nodeStudioMcpHelperProbe,
): Promise<StudioMcpHelper> {
  if (platform !== "win32") {
    return {
      command: studioMcpCommand(platform, environment),
      installPath: studioMcpInstallPath(platform, environment),
      source: null,
    };
  }

  const direct = (path: string, source: StudioMcpHelperSource): StudioMcpHelper => ({
    command: [path],
    installPath: path,
    source,
  });
  const batPath = studioMcpInstallPath(platform, environment);
  const dataDirectory = environment.localAppData ?? "C:\\Users\\Default\\AppData\\Local";

  const bat = batPath ? await probe.readText(batPath) : null;
  const fromBat = bat ? parseStudioMcpBatPath(bat) : null;
  if (fromBat && (await probe.exists(fromBat))) return direct(fromBat, "bat_path");

  const registry = await probe.queryContentFolder(environment);
  const contentFolder = registry ? parseContentFolder(registry) : null;
  const registryVersion = contentFolder ? win32.normalize(win32.join(contentFolder, "..")) : null;
  const fromRegistry = registryVersion ? win32.join(registryVersion, "StudioMCP.exe") : null;
  if (fromRegistry && (await probe.exists(fromRegistry))) return direct(fromRegistry, "registry");

  // A stale bat or registry path still says where Studio keeps its versions, which may not be
  // the usual place, so the versions next to the stale one are searched too.
  const versionsFolders = new Map<string, string>();
  for (const folder of [
    win32.join(dataDirectory, "Roblox", "Versions"),
    fromBat ? versionsFolderOf(win32.dirname(fromBat)) : null,
    registryVersion ? versionsFolderOf(registryVersion) : null,
  ]) {
    if (folder && !versionsFolders.has(folder.toLowerCase())) {
      versionsFolders.set(folder.toLowerCase(), folder);
    }
  }
  let newest: { path: string; modified: number } | null = null;
  for (const versions of versionsFolders.values()) {
    for (const entry of await probe.listDirectory(versions)) {
      if (!/^version-/i.test(entry)) continue;
      const path = win32.join(versions, entry, "StudioMCP.exe");
      const modified = await probe.modifiedTime(path);
      if (modified !== null && (!newest || modified > newest.modified)) {
        newest = { path, modified };
      }
    }
  }
  if (newest) return direct(newest.path, "versions_scan");

  // Newer Studio installs keep the helper in their own folder instead of Roblox\Versions.
  const studioFolder = win32.join(dataDirectory, "Roblox Studio", "StudioMCP.exe");
  if (await probe.exists(studioFolder)) return direct(studioFolder, "studio_folder");

  // Without mcp.bat, Studio isn't installed or hasn't set up MCP, and the missing bat says so.
  if (bat === null) {
    return { command: studioMcpCommand(platform, environment), installPath: batPath, source: null };
  }
  const searched = [
    fromBat,
    fromRegistry,
    ...[...versionsFolders.values()].map((folder) => win32.join(folder, "version-*")),
    win32.dirname(studioFolder),
  ].filter((path): path is string => path !== null);
  return {
    command: [],
    installPath: null,
    source: "missing",
    // These end up in error reports, so home folders are swapped for `~` here already.
    searched: [...new Set(searched)].map((path) => scrubErrorText(path)),
  };
}
