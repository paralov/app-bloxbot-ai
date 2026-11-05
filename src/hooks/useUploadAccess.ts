import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import type { StudioTarget } from "@/types/studioTarget";

/** Someone's in Studio when this happens, so it reaches them there, and only once for every card. */
function announceUploadsOn() {
  notify.success("Uploads are on", {
    name: "uploads_turned_on",
    id: "uploads-on",
    system: { body: "Come back to BloxBot to upload your model." },
  });
}

/**
 * What this place can do about uploads. Only Studio can change it, so this watches until it's ready.
 * Asking runs no script, so it can't disturb what someone's doing in Studio.
 */
export function useUploadAccess(
  studio: StudioTarget | null,
  modelUrl: string | null,
  enabled = true,
) {
  const studioKey = studio?.key ?? null;
  // Watching stops once it's ready, so another place under the same key needs its own answer.
  const queryKey = qk.uploadAccess(studio, modelUrl);
  const query = useQuery({
    queryKey,
    queryFn: () => desktop.getUploadAccess(studioKey, modelUrl),
    enabled,
    refetchInterval: (current) => (current.state.data?.state === "ready" ? false : 4_000),
    // Someone setting this up is in Studio, with BloxBot behind it, which is when this matters most.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: (current) => current.state.data?.state !== "ready",
  });

  const state = query.data?.state;
  // Kept per place, since switching to one that was already set up isn't news.
  const place = queryKey[1];
  const previous = useRef({ place, state });
  useEffect(() => {
    const before = previous.current;
    if (before.place === place && before.state && before.state !== "ready" && state === "ready") {
      announceUploadsOn();
    }
    previous.current = { place, state };
  }, [place, state]);

  return query;
}
