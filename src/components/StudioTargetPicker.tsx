import { Monitor } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { STUDIO_SETUP_STEPS } from "@/components/StudioSetup";
import { MENU_LABEL, MENU_TRIGGER, MenuChevron, MenuContent, MenuItem } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { analyticsProperties } from "@/lib/analytics";
import { placeName, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Three fruitless Refreshes inside 30 seconds means someone is stuck, not just checking. */
const STUCK_REFRESHES = 3;
const STUCK_WINDOW_MS = 30_000;
/** Studio answers in milliseconds, too fast to see, so Refresh stays busy at least this long. */
const MIN_REFRESH_MS = 600;

function foundLabel(count: number): string {
  if (count === 0) return "No Studio found";
  return `${count} ${count === 1 ? "Studio" : "Studios"} found`;
}

function Spinner() {
  return (
    <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
  );
}

export default function StudioTargetPicker({
  onOpenSetup,
  openRequest = 0,
  onWorkedWithoutStudio,
}: {
  onOpenSetup: () => void;
  onWorkedWithoutStudio?: () => void;
  /** Counts up when something else on screen wants this open. */
  openRequest?: number;
}) {
  const studioTarget = useStudioTargetOptional();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [stuck, setStuck] = useState(false);
  const closeAfterSelecting = useRef(false);
  const emptyRefreshes = useRef<number[]>([]);
  const stuckRef = useRef(false);
  const selectingKey = studioTarget?.selectingKey ?? null;
  const selectError = studioTarget?.error ?? null;
  const hasTargets = (studioTarget?.targets.length ?? 0) > 0;

  // Compared with the last one seen, since this comes back with the same count after a remount.
  const seenOpenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === seenOpenRequest.current) return;
    seenOpenRequest.current = openRequest;
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!closeAfterSelecting.current || selectingKey !== null) return;
    closeAfterSelecting.current = false;
    // A failed switch stays open, so the error below it can be read.
    if (!selectError) setOpen(false);
  }, [selectingKey, selectError]);

  // Studio can turn up from the background check too, not only from Refresh.
  useEffect(() => {
    if (!hasTargets) return;
    emptyRefreshes.current = [];
    stuckRef.current = false;
    setStuck(false);
  }, [hasTargets]);

  if (!studioTarget) return null;
  const { targets, selected, status, error, missing, withoutStudio, discover, select } =
    studioTarget;
  const busy = status === "loading" || refreshing || selectingKey !== null;

  const buttonLabel =
    status === "loading"
      ? "Finding Studios…"
      : (selected?.label ??
        (withoutStudio
          ? "Not using Studio"
          : status === "empty" || status === "error"
            ? "No Studio"
            : "Choose Studio"));

  // Two unpublished places with one name are otherwise the same row twice.
  const twinNumber = (target: (typeof targets)[number]) => {
    const twins = targets.filter((other) => other.label === target.label);
    return twins.length < 2
      ? target.detail
      : `${target.detail ?? "Window"} ${twins.indexOf(target) + 1} of ${twins.length}`;
  };

  const refresh = async () => {
    // Refresh keeps keyboard focus while it's busy, so it can't use the disabled attribute.
    if (busy) return;
    studioTarget.clearError();
    setRefreshing(true);
    setChecked(false);
    const [found] = await Promise.all([
      discover(),
      new Promise((resolve) => window.setTimeout(resolve, MIN_REFRESH_MS)),
    ]);
    setRefreshing(false);
    setChecked(true);
    const now = Date.now();
    emptyRefreshes.current =
      found > 0 ? [] : [...emptyRefreshes.current, now].filter((at) => now - at < STUCK_WINDOW_MS);
    if (emptyRefreshes.current.length >= STUCK_REFRESHES && !stuckRef.current && !missing) {
      stuckRef.current = true;
      setStuck(true);
      posthog.capture(
        "studio_target_guidance_shown",
        analyticsProperties("studio_target", { trigger: "repeated_refresh", status }),
      );
    }
  };

  const showMeHow = (
    <button
      type="button"
      onClick={() => {
        posthog.capture(
          "studio_target_guidance_followed",
          analyticsProperties("studio_target", {
            trigger: stuck ? "repeated_refresh" : "empty",
            status,
          }),
        );
        setOpen(false);
        onOpenSetup();
      }}
      className={`mt-2 inline-flex h-7 items-center rounded-md px-3 text-xs font-medium transition-colors ${
        stuck ? "bg-foreground text-background hover:opacity-90" : "border hover:bg-accent"
      }`}
    >
      Show me how
    </button>
  );

  const connectSteps = (
    <div className="px-2 pb-2">
      {/* Always in the page, so a screen reader announces it when the words arrive. */}
      <output className="block">
        {stuck ? (
          <p className="pb-1.5 text-xs font-medium">Still no Studio. Follow these steps.</p>
        ) : null}
      </output>
      <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
        {STUDIO_SETUP_STEPS.map((step) => (
          <li key={step.title}>{step.description}</li>
        ))}
      </ol>
      {withoutStudio ? null : (
        <p className="pt-1.5 text-xs leading-relaxed text-muted-foreground">
          BloxBot connects on its own once Studio is ready.
        </p>
      )}
      {showMeHow}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Nothing checks in the background for a chat that isn't using Studio.
          if (withoutStudio) void discover();
          posthog.capture(
            "studio_target_picker_opened",
            analyticsProperties("studio_target", { status }),
          );
        } else {
          setChecked(false);
          // Closing it counts as moving on, so a later Refresh isn't called stuck straight away.
          emptyRefreshes.current = [];
          stuckRef.current = false;
          setStuck(false);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Roblox Studio: ${placeName(buttonLabel)}`}
          className={MENU_TRIGGER}
        >
          <Monitor aria-hidden="true" size={14} className="shrink-0" />
          <span className="min-w-0 truncate text-left" title={buttonLabel}>
            {placeName(buttonLabel)}
          </span>
          {status === "loading" ? <Spinner /> : <MenuChevron />}
        </button>
      </PopoverTrigger>
      <MenuContent aria-label="Choose Roblox Studio" align="end" className="w-64">
        <div className="flex items-center justify-between gap-2">
          <output className={`${MENU_LABEL} min-w-0 truncate`}>
            {checked && !error ? foundLabel(targets.length) : "Roblox Studio"}
          </output>
          <button
            type="button"
            onClick={() => void refresh()}
            aria-disabled={busy}
            aria-busy={refreshing}
            className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
          >
            {refreshing ? <Spinner /> : null}
            Refresh
          </button>
        </div>
        {status === "loading" ? (
          <output className="block space-y-1" aria-label="Loading Studio targets">
            {[0, 1].map((item) => (
              <div key={item} className="h-8 animate-pulse rounded-md bg-muted" />
            ))}
          </output>
        ) : status === "empty" && missing ? (
          <div className="px-2 pb-2">
            <p className="text-xs leading-relaxed">
              {placeName(missing.label)} isn't open. Reopen it in Studio.
            </p>
            {showMeHow}
          </div>
        ) : status === "empty" ? (
          <>
            {withoutStudio ? (
              <p className="px-2 pb-1.5 text-xs leading-relaxed">
                This chat isn't using Studio. To use it, follow these steps.
              </p>
            ) : null}
            {connectSteps}
          </>
        ) : status === "error" ? (
          <>
            <div className="px-2 pb-1.5">
              <p className="text-sm">Couldn’t find Studios</p>
              <p
                className="mt-0.5 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground"
                title={error ?? undefined}
              >
                {error ?? "The Studio integration could not be initialized."}
              </p>
              <a
                href="https://create.roblox.com/docs/studio/setup"
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-block text-xs underline underline-offset-2 hover:opacity-80"
              >
                Get Roblox Studio
              </a>
            </div>
            {connectSteps}
          </>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {withoutStudio ? (
              <p className="px-2 pb-1.5 text-xs leading-relaxed text-muted-foreground">
                This chat isn't using Studio. Choose one to start.
              </p>
            ) : null}
            {missing ? (
              <p className="px-2 pb-1.5 text-xs leading-relaxed text-muted-foreground">
                {studioTarget.sendBlock}
              </p>
            ) : null}
            {targets.map((target) => (
              <MenuItem
                key={target.key}
                checked={selected?.key === target.key}
                description={twinNumber(target)}
                trailing={selectingKey === target.key ? <Spinner /> : undefined}
                aria-disabled={selectingKey !== null}
                onClick={() => {
                  if (selectingKey !== null) return;
                  if (selected?.key === target.key) {
                    setOpen(false);
                    return;
                  }
                  closeAfterSelecting.current = true;
                  void select(target);
                }}
              >
                <span className="truncate">{placeName(target.label)}</span>
              </MenuItem>
            ))}
          </div>
        )}
        {error && status !== "error" ? (
          <p
            role="alert"
            className="line-clamp-3 break-words px-2 py-1.5 text-xs leading-relaxed text-destructive"
            title={error}
          >
            {error}
          </p>
        ) : null}
        {withoutStudio || status === "loading" ? null : (
          <button
            type="button"
            onClick={() => {
              posthog.capture(
                "studio_target_work_without",
                analyticsProperties("studio_target", { status, had_place: selected !== null }),
              );
              studioTarget.workWithoutStudio();
              onWorkedWithoutStudio?.();
              setOpen(false);
            }}
            className="mx-2 mb-1 mt-1 block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Work without Studio
          </button>
        )}
      </MenuContent>
    </Popover>
  );
}
