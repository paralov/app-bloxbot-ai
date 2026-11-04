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
  const twins = studioTarget?.twins ?? 0;
  const rejoinedByName = !!studioTarget?.rejoinedByName && selected !== null;
  const hidden =
    !studioTarget ||
    status === "loading" ||
    (selected !== null && !rejoinedByName) ||
    !!studioTarget.selectingKey;

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
    : rejoinedByName && selected
      ? `Using ${placeName(selected.label)}, matched by name.`
      : status === "error"
        ? "Couldn't reach Studio."
        : place && twins > 1
          ? `${twins} places named ${place} are open.`
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
        {message && place && twins < 2 && canChoose && status !== "error"
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
            {rejoinedByName
              ? "Choose another"
              : !canChoose
                ? "Show me how"
                : place && twins < 2
                  ? "choose another"
                  : "Choose one"}
          </button>
        </div>
      ) : null}
    </>
  );
}
