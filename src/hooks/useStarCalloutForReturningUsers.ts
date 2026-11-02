import { useEffect, useRef } from "react";

import { useSessions } from "@/hooks/useSessions";
import { isVisibleSession } from "@/lib/sessionVisibility";
import { showStarCallout } from "@/lib/starCallout";

/**
 * Someone with chats from before this launch has already used BloxBot, so they are asked right away.
 * Only the first load counts: a chat created later in this launch doesn't make a new user returning.
 */
export function useStarCalloutForReturningUsers(): void {
  const { data: sessions } = useSessions();
  const checked = useRef(false);

  useEffect(() => {
    if (!sessions || checked.current) return;
    checked.current = true;
    // The first prefetch of the session list can still hold hidden helper chats.
    if (!sessions.some(isVisibleSession)) return;
    showStarCallout().catch((error) => {
      console.warn("Failed to show the GitHub callout:", error);
    });
  }, [sessions]);
}
