import { createElement, useEffect } from "react";

import { UpdateReleaseNotes } from "@/components/UpdateReleaseNotes";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";

// ── Semver helpers ──────────────────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

let updaterStarted = false;

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

export function useUpdater(): void {
  useEffect(() => {
    if (updaterStarted) return;
    updaterStarted = true;

    let cancelled = false;

    async function run() {
      // Small delay so the app can finish rendering first.
      await new Promise((r) => setTimeout(r, 3000));
      if (cancelled) return;

      try {
        const update = await desktop.checkForUpdate();
        if (cancelled || !update) return;

        const currentVersion = await desktop.getVersion();
        const current = parseSemver(currentVersion);
        const next = parseSemver(update.version);
        const patch = current && next ? isPatchOnly(current, next) : false;

        if (patch) {
          // Patch update — auto-install silently.
          console.debug(
            `[updater] Auto-installing patch update ${currentVersion} → ${update.version}`,
          );
          await desktop.installUpdate();
        } else {
          // Minor/major — show persistent toast requiring manual action.
          console.debug(`[updater] Prompting for update ${currentVersion} → ${update.version}`);

          notify.message(`BloxBot ${update.version} is available`, {
            name: "update_available",
            className: "update-available-toast",
            description: createElement(UpdateReleaseNotes, { body: update.body }),
            duration: Number.POSITIVE_INFINITY,
            system: { body: "Open BloxBot to install it." },
            action: {
              label: "Install & Restart",
              onClick: async () => {
                const toastId = notify.loading("Installing update...");
                try {
                  await desktop.installUpdate();
                } catch (err) {
                  console.error("[updater] Failed to install update:", err);
                  notify.dismiss(toastId);
                  notify.error("Update failed", {
                    description: err instanceof Error ? err.message : "Installation failed",
                  });
                }
              },
            },
          });
        }
      } catch (err) {
        console.error("[updater] Failed to check for updates:", err);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);
}
