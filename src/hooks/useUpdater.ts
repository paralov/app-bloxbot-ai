import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";

// ── Semver helpers ──────────────────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): SemVer | null {
  const match = version.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Returns true when the new version is a patch-only bump (e.g. 0.2.1→0.2.2). */
function isPatchOnly(current: SemVer, next: SemVer): boolean {
  return current.major === next.major && current.minor === next.minor;
}

// ── Hook ────────────────────────────────────────────────────────────────

export interface UpdateInfo {
  version: string;
  body?: string;
  /** True when the update is a patch bump and will auto-install. */
  isPatch: boolean;
}

export type UpdaterStatus = "idle" | "checking" | "downloading" | "prompting";

interface UseUpdaterReturn {
  status: UpdaterStatus;
  /** Non-null when a minor/major update is available and waiting for user action. */
  pendingUpdate: UpdateInfo | null;
  /** User accepted — download + install + relaunch. */
  installUpdate: () => Promise<void>;
  /** User dismissed the prompt. */
  dismissUpdate: () => void;
}

export function useUpdater(): UseUpdaterReturn {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  const [updateHandle, setUpdateHandle] = useState<Update | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      // Small delay so the app can finish rendering first.
      await new Promise((r) => setTimeout(r, 3000));
      if (cancelled) return;

      setStatus("checking");
      try {
        const update = await check();
        if (cancelled || !update) {
          setStatus("idle");
          return;
        }

        const currentVersion = await getVersion();
        const current = parseSemver(currentVersion);
        const next = parseSemver(update.version);
        const patch = current && next ? isPatchOnly(current, next) : false;

        const info: UpdateInfo = {
          version: update.version,
          body: update.body ?? undefined,
          isPatch: patch,
        };

        if (patch) {
          // Patch update — auto-install silently.
          console.debug(
            `[updater] Auto-installing patch update ${currentVersion} → ${update.version}`,
          );
          setStatus("downloading");
          await update.downloadAndInstall();
          // Relaunch after install.
          await relaunch();
        } else {
          // Minor/major — show prompt to the user.
          console.debug(`[updater] Prompting for update ${currentVersion} → ${update.version}`);
          setUpdateHandle(update);
          setPendingUpdate(info);
          setStatus("prompting");
        }
      } catch (err) {
        console.error("[updater] Failed to check for updates:", err);
        setStatus("idle");
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function installUpdate() {
    if (!updateHandle) return;
    try {
      setStatus("downloading");
      await updateHandle.downloadAndInstall();
      await relaunch();
    } catch (err) {
      console.error("[updater] Failed to install update:", err);
      setStatus("idle");
    }
  }

  function dismissUpdate() {
    setPendingUpdate(null);
    setUpdateHandle(null);
    setStatus("idle");
  }

  return { status, pendingUpdate, installUpdate, dismissUpdate };
}
