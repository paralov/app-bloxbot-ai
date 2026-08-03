import posthog from "posthog-js/dist/module.full.no-external.js";
import { createElement, useEffect } from "react";
import { toast } from "sonner";

import { UpdateReleaseNotes } from "@/components/UpdateReleaseNotes";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";

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

        posthog.capture(
          "update_available",
          analyticsProperties("updater", {
            update_version: update.version,
            current_version: currentVersion,
            is_patch: patch,
          }),
        );

        if (patch) {
          // Patch update — auto-install silently.
          console.debug(
            `[updater] Auto-installing patch update ${currentVersion} → ${update.version}`,
          );
          posthog.capture(
            "update_auto_installed",
            analyticsProperties("updater", { update_version: update.version }),
          );
          await desktop.installUpdate();
        } else {
          // Minor/major — show persistent toast requiring manual action.
          console.debug(`[updater] Prompting for update ${currentVersion} → ${update.version}`);

          toast(`BloxBot ${update.version} is available`, {
            className: "update-available-toast",
            description: createElement(UpdateReleaseNotes, { body: update.body }),
            duration: Number.POSITIVE_INFINITY,
            action: {
              label: "Install & Restart",
              onClick: async () => {
                const toastId = toast.loading("Installing update...");
                try {
                  await desktop.installUpdate();
                } catch (err) {
                  console.error("[updater] Failed to install update:", err);
                  toast.dismiss(toastId);
                  toast.error("Update failed", {
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
