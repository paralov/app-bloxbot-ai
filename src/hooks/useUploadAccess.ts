import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";

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
export function useUploadAccess(studioKey: string | null, modelUrl: string | null, enabled = true) {
  const query = useQuery({
    queryKey: qk.uploadAccess(studioKey, modelUrl),
    queryFn: () => desktop.getUploadAccess(studioKey, modelUrl),
    enabled,
    refetchInterval: (current) => (current.state.data?.state === "ready" ? false : 4_000),
    // Someone setting this up is in Studio, with BloxBot behind it, which is when this matters most.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: (current) => current.state.data?.state !== "ready",
  });

  const state = query.data?.state;
  // Kept per place, since switching to one that was already set up isn't news.
  const previous = useRef({ studioKey, state });
  useEffect(() => {
    const before = previous.current;
    if (
      before.studioKey === studioKey &&
      before.state &&
      before.state !== "ready" &&
      state === "ready"
    ) {
      announceUploadsOn();
    }
    previous.current = { studioKey, state };
  }, [studioKey, state]);

  return query;
}
