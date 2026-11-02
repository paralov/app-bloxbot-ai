import { useEffect, useRef } from "react";

import { useSessions } from "@/hooks/useSessions";
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
    if (sessions.length === 0) return;
    showStarCallout().catch((error) => {
      console.warn("Failed to show the GitHub callout:", error);
    });
  }, [sessions]);
}
