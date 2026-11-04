import { Monitor } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { STUDIO_SETUP_STEPS } from "@/components/StudioSetup";
import { MENU_LABEL, MENU_TRIGGER, MenuChevron, MenuContent, MenuItem } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { analyticsProperties } from "@/lib/analytics";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Three fruitless Refreshes inside 30 seconds means someone is stuck, not just checking. */
const STUCK_REFRESHES = 3;
const STUCK_WINDOW_MS = 30_000;
/** Studio answers in milliseconds, too fast to see, so Refresh stays busy at least this long. */
const MIN_REFRESH_MS = 600;

type GuidanceTrigger = "repeated_refresh" | "manual";

function foundLabel(count: number): string {
  if (count === 0) return "Checked · No Studios found";
  return `Checked · ${count} ${count === 1 ? "Studio" : "Studios"} found`;
}

/** Studio's window label ends with a place ID nobody needs to read. */
function placeName(label: string): string {
  return label.replace(/\s*\(placeId:[^)]*\)$/, "");
}

function Spinner() {
  return (
    <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
  );
}

export default function StudioTargetPicker({ onOpenSetup }: { onOpenSetup: () => void }) {
  const studioTarget = useStudioTargetOptional();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [guidance, setGuidance] = useState<GuidanceTrigger | null>(null);
  const closeAfterSelecting = useRef(false);
  const emptyRefreshes = useRef<number[]>([]);
  const selectingKey = studioTarget?.selectingKey ?? null;
  const selectError = studioTarget?.error ?? null;
  const hasTargets = (studioTarget?.targets.length ?? 0) > 0;

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
    setGuidance(null);
  }, [hasTargets]);

  if (!studioTarget) return null;
  const { targets, selected, status, error, discover, select } = studioTarget;

  const buttonLabel =
    status === "loading"
      ? "Finding Studios…"
      : (selected?.label ?? (status === "empty" ? "No Studios" : "Choose Studio"));

  const showGuidance = (trigger: GuidanceTrigger) => {
    setGuidance(trigger);
    posthog.capture(
      "studio_target_guidance_shown",
      analyticsProperties("studio_target", { trigger, status }),
    );
  };

  const refresh = async () => {
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
    if (emptyRefreshes.current.length >= STUCK_REFRESHES && !guidance) {
      showGuidance("repeated_refresh");
    }
  };

  const connectHelp = (
    <>
      <button
        type="button"
        aria-expanded={guidance !== null}
        onClick={() => {
          if (guidance) {
            emptyRefreshes.current = [];
            setGuidance(null);
          } else {
            showGuidance("manual");
          }
        }}
        className="mx-2 mb-2 block text-xs text-foreground underline underline-offset-2 hover:opacity-80"
      >
        {guidance ? "Hide steps" : "Show steps"}
      </button>
      {guidance ? (
        <div className="px-2 pb-2">
          {guidance === "repeated_refresh" ? (
            <p className="pb-1.5 text-xs font-medium">Still no Studio · Follow these steps</p>
          ) : null}
          <ol className="list-decimal space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {STUDIO_SETUP_STEPS.map((step) => (
              <li key={step.title}>{step.description}</li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => {
              posthog.capture(
                "studio_target_guidance_followed",
                analyticsProperties("studio_target", { trigger: guidance, status }),
              );
              setOpen(false);
              onOpenSetup();
            }}
            className="mt-2 inline-flex h-7 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            Walk me through it
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          posthog.capture(
            "studio_target_picker_opened",
            analyticsProperties("studio_target", { status }),
          );
        } else {
          setChecked(false);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={MENU_TRIGGER}>
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
            disabled={status === "loading" || refreshing || selectingKey !== null}
            aria-busy={refreshing}
            className="mr-1 inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
        ) : status === "empty" ? (
          <>
            <p className="px-2 pb-1.5 text-xs leading-relaxed text-muted-foreground">
              Open a place in Studio and turn on its MCP server · BloxBot keeps checking
            </p>
            {connectHelp}
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
            </div>
            {connectHelp}
          </>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {targets.map((target) => (
              <MenuItem
                key={target.key}
                checked={selected?.key === target.key}
                description={target.detail}
                trailing={selectingKey === target.key ? <Spinner /> : undefined}
                disabled={selectingKey !== null}
                onClick={() => {
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
      </MenuContent>
    </Popover>
  );
}
