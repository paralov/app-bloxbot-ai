import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { analyticsProperties } from "@/lib/analytics";
import { placeName, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Says why this chat has no Studio to work in, right where someone is about to ask it for something. */
export default function StudioNotice({
  onOpenSetup,
  onOpenPicker,
}: {
  onOpenSetup: () => void;
  onOpenPicker: () => void;
}) {
  const studioTarget = useStudioTargetOptional();
  const status = studioTarget?.status ?? "loading";
  const selected = studioTarget?.selected ?? null;
  const missing = studioTarget?.missing ?? null;
  const canChoose = (studioTarget?.targets.length ?? 0) > 0;
  const hidden =
    !studioTarget || status === "loading" || selected !== null || !!studioTarget.selectingKey;

  // The notice going away says nothing to a screen reader, so a return gets said out loud.
  const [returned, setReturned] = useState<string | null>(null);
  const wasMissing = useRef(false);
  useEffect(() => {
    if (missing) {
      wasMissing.current = true;
      setReturned(null);
    } else if (selected && wasMissing.current) {
      wasMissing.current = false;
      setReturned(`${placeName(selected.label)} is connected.`);
    }
  }, [missing, selected]);

  const place = missing ? placeName(missing.label) : null;
  const message = hidden
    ? null
    : place
      ? canChoose
        ? `${place} isn't open. Reopen it or`
        : `${place} isn't open. Reopen it in Studio to keep going.`
      : canChoose
        ? "Several Studios are open."
        : "No Studio connected.";

  return (
    <>
      {/* Always in the page, so a screen reader announces it when the words arrive. */}
      <output className="sr-only">
        {message && place && canChoose
          ? `${place} isn't open. Reopen it or choose another.`
          : (message ?? returned)}
      </output>
      {message ? (
        <div className="flex shrink-0 items-center justify-center gap-1.5 px-4 pb-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="min-w-0 truncate">
            {message}
          </span>
          <button
            type="button"
            onClick={() => {
              if (canChoose) {
                onOpenPicker();
                return;
              }
              posthog.capture(
                "studio_target_guidance_followed",
                analyticsProperties("studio_target", { trigger: "notice", status }),
              );
              onOpenSetup();
            }}
            className="shrink-0 text-foreground underline underline-offset-2 hover:opacity-80"
          >
            {canChoose ? (place ? "choose another" : "Choose one") : "Show me how"}
          </button>
        </div>
      ) : null}
    </>
  );
}
