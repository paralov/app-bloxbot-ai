import { loadConfig, patchConfig } from "@/lib/config";
import { desktop } from "@/lib/desktop";
import { isWindowFocused, notify } from "@/lib/notifications";

export const STAR_CALLOUT_PROMPTS = 3;
const REPOSITORY_URL = "https://github.com/paralov/app-bloxbot-ai";
const COUNT_WAIT_MS = 5000;
let writes: Promise<void> = Promise.resolve();
const counting = new Set<Promise<void>>();

/** Counts prompts until the callout has been shown, after which the count is no longer needed. */
export function recordPromptSent(accepted: Promise<unknown>): Promise<void> {
  // A fast turn can finish before its request returns, so the callout check below waits for this.
  // Only the writes queue, so a request that never returns holds up nothing but itself.
  const counted = accepted.then(
    () => {
      const write = writes.then(async () => {
        const { promptsSent, starCalloutShown } = await loadConfig();
        if (starCalloutShown || promptsSent >= STAR_CALLOUT_PROMPTS) return;
        await patchConfig({ promptsSent: promptsSent + 1 });
      });
      writes = write.catch(() => undefined);
      return write;
    },
    () => undefined,
  );
  // The check only waits so long for each count, so a stuck request stops delaying it.
  const settled = Promise.race([
    counted.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, COUNT_WAIT_MS)),
  ]).finally(() => {
    counting.delete(settled);
  });
  counting.add(settled);
  return counted;
}

/**
 * Asks once, when a turn has just finished and the user is here to see it. If they are away the
 * next finished turn tries again, so the ask never interrupts a reply or waits unseen.
 */
export async function maybeShowStarCallout(): Promise<void> {
  if (!isWindowFocused()) return;
  await Promise.all(counting);
  const { promptsSent } = await loadConfig();
  if (promptsSent >= STAR_CALLOUT_PROMPTS) await showStarCallout();
}

/** Asks unless it already has. Returning users skip the prompt count: theirs started at zero. */
export async function showStarCallout(): Promise<void> {
  const { starCalloutShown } = await loadConfig();
  if (starCalloutShown) return;
  notify.message("Enjoying BloxBot?", {
    name: "github_star",
    id: "github-star-callout",
    className: "card-toast",
    description: "A star on GitHub helps other Roblox developers find it.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Star on GitHub",
      onClick: () => {
        desktop.openUrl(REPOSITORY_URL).catch((error) => {
          console.warn("Failed to open GitHub:", error);
        });
      },
    },
    cancel: { label: "Not now", onClick: () => {} },
  });
  // Saved only once it is on screen, so a failure to show it leaves the ask for a later turn.
  await patchConfig({ starCalloutShown: true });
}
