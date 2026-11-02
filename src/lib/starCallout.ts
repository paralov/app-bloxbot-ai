import { loadConfig, patchConfig } from "@/lib/config";
import { desktop } from "@/lib/desktop";
import { isWindowFocused, notify } from "@/lib/notifications";

export const STAR_CALLOUT_PROMPTS = 3;
const REPOSITORY_URL = "https://github.com/paralov/app-bloxbot-ai";
let counting: Promise<void> = Promise.resolve();

/** Counts prompts until the callout has been shown, after which the count is no longer needed. */
export function recordPromptSent(): Promise<void> {
  // One at a time, so chats finishing together can't lose a count.
  const counted = counting.then(async () => {
    const { promptsSent, starCalloutShown } = await loadConfig();
    if (starCalloutShown || promptsSent >= STAR_CALLOUT_PROMPTS) return;
    await patchConfig({ promptsSent: promptsSent + 1 });
  });
  counting = counted.catch(() => undefined);
  return counted;
}

/**
 * Asks once, when a turn has just finished and the user is here to see it. If they are away the
 * next finished turn tries again, so the ask never interrupts a reply or waits unseen.
 */
export async function maybeShowStarCallout(): Promise<void> {
  if (!isWindowFocused()) return;
  await counting;
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
