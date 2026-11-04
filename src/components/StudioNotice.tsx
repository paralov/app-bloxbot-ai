import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { analyticsProperties } from "@/lib/analytics";
import { placeName, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const LINK = "shrink-0 text-foreground underline underline-offset-2 hover:opacity-80";

/** Says why this chat has no Studio to work in, right where someone is about to ask it for something. */
export default function StudioNotice({
  onOpenSetup,
  onOpenPicker,
  onWorkedWithoutStudio,
  quiet = false,
}: {
  onOpenSetup: () => void;
  onOpenPicker: () => void;
  onWorkedWithoutStudio?: () => void;
  /**
   * Under way without a Studio, or Studio was skipped: this chat is about something else, so this
   * stays out of it unless there's a place at stake.
   */
  quiet?: boolean;
}) {
  const studioTarget = useStudioTargetOptional();
  const status = studioTarget?.status ?? "loading";
  const selected = studioTarget?.selected ?? null;
  const missing = studioTarget?.missing ?? null;
  const openCount = studioTarget?.targets.length ?? 0;
  const canChoose = openCount > 0;
  const unknownPlace = studioTarget?.unknownPlace ?? false;
  const twins = studioTarget?.twins ?? 0;
  const nameMatch = studioTarget?.nameMatch ?? null;
  const hidden =
    !studioTarget ||
    status === "loading" ||
    selected !== null ||
    studioTarget.withoutStudio ||
    !!studioTarget.selectingKey ||
    (quiet && !missing && !unknownPlace) ||
    // One Studio and no choice yet is the moment before it's picked up.
    (openCount === 1 && !missing && !unknownPlace);

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
    : place && status === "error"
      ? "Couldn't reach Studio."
      : place && twins > 1
        ? `${twins} places named ${place} are open.`
        : place && nameMatch
          ? `Is the open ${place} this chat's place?`
          : place
            ? canChoose
              ? `${place} isn't open. Reopen it or choose another.`
              : `${place} isn't open. Reopen it to use Studio again.`
            : unknownPlace
              ? canChoose
                ? "Choose which Studio this chat worked in."
                : "This chat worked in a Studio that isn't open."
              : canChoose
                ? "Several Studios are open."
                : "No Studio connected.";

  const openSetup = () => {
    posthog.capture(
      "studio_target_guidance_followed",
      analyticsProperties("studio_target", { trigger: "notice", status }),
    );
    onOpenSetup();
  };
  const useMatch = () => {
    if (!nameMatch) return;
    // This button goes away with the question, so focus moves to what comes next.
    void studioTarget?.select(nameMatch).then((worked) => {
      if (worked) document.querySelector<HTMLElement>('[aria-label="Message"]')?.focus();
    });
  };
  const workWithoutStudio = () => {
    posthog.capture(
      "studio_target_work_without",
      analyticsProperties("studio_target", { status, had_place: place !== null }),
    );
    studioTarget?.workWithoutStudio();
    setReturned("Working without Studio.");
    onWorkedWithoutStudio?.();
    document.querySelector<HTMLElement>('[aria-label="Message"]')?.focus();
  };

  return (
    <>
      {/* Always in the page, so a screen reader announces it when the words arrive. */}
      <output className="sr-only">{message ?? returned}</output>
      {message ? (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-0.5 px-4 pb-2 text-xs text-muted-foreground">
          <span aria-hidden="true" className="text-center">
            {message}
          </span>
          {nameMatch ? (
            <button type="button" onClick={useMatch} className={LINK}>
              Use it
            </button>
          ) : null}
          {canChoose ? (
            <button type="button" onClick={onOpenPicker} className={LINK}>
              {nameMatch || (place && twins === 0) ? "Choose another" : "Choose one"}
            </button>
          ) : (
            <button type="button" onClick={openSetup} className={LINK}>
              Show me how
            </button>
          )}
          <button type="button" onClick={workWithoutStudio} className={LINK}>
            Work without Studio
          </button>
          {studioTarget?.error && status !== "error" ? (
            <p role="alert" className="w-full text-center text-destructive">
              {studioTarget.error}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
