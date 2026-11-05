import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Drives can be mapped while BloxBot runs, but not so often that every file read should ask. */
const FRESH_FOR_MS = 30_000;

// DriveType comes from GetDriveType, which answers without reaching the share.
const LIST_NETWORK_DRIVES =
  "[System.IO.DriveInfo]::GetDrives() | Where-Object DriveType -eq 'Network' | ForEach-Object { $_.Name.Substring(0, 1) }";

let cached: { at: number; letters: Promise<Set<string>> } | null = null;

/**
 * The drive letters Windows has mapped to a network share, like "Z". Reading Z:\Crate.fbx sends
 * the person's Windows sign-in to that share just as \\server\share would. Empty elsewhere, and
 * when Windows can't say, since every drive letter can't be refused.
 */
export function networkDriveLetters(
  platform: NodeJS.Platform = process.platform,
  now = Date.now(),
): Promise<Set<string>> {
  if (platform !== "win32") return Promise.resolve(new Set());
  if (cached && now - cached.at < FRESH_FOR_MS) return cached.letters;
  const letters = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", LIST_NETWORK_DRIVES],
    { windowsHide: true, timeout: 10_000 },
  ).then(
    ({ stdout }) =>
      new Set(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim().toUpperCase())
          .filter((line) => /^[A-Z]$/.test(line)),
      ),
    (error: unknown) => {
      console.warn("[files] couldn't list network drives", error);
      return new Set<string>();
    },
  );
  cached = { at: now, letters };
  return letters;
}

/** Whether a Windows path is on one of those drives, as "Z:\Models\Crate.fbx" or "z:/Crate.fbx". */
export function onNetworkDrive(path: string, letters: Set<string>): boolean {
  const drive = /^([A-Za-z]):/.exec(path)?.[1];
  return drive !== undefined && letters.has(drive.toUpperCase());
}
