import { Monitor } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { MENU_TRIGGER, MenuChevron, MenuContent, MenuItem, MenuLabel } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { analyticsProperties } from "@/lib/analytics";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Studio's window label ends with a place ID nobody needs to read. */
function placeName(label: string): string {
  return label.replace(/\s*\(placeId:[^)]*\)$/, "");
}

function Spinner() {
  return (
    <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent" />
  );
}

export default function StudioTargetPicker() {
  const studioTarget = useStudioTargetOptional();
  const [open, setOpen] = useState(false);
  const closeAfterSelecting = useRef(false);
  const selectingKey = studioTarget?.selectingKey ?? null;
  const selectError = studioTarget?.error ?? null;

  useEffect(() => {
    if (!closeAfterSelecting.current || selectingKey !== null) return;
    closeAfterSelecting.current = false;
    // A failed switch stays open, so the error below it can be read.
    if (!selectError) setOpen(false);
  }, [selectingKey, selectError]);

  if (!studioTarget) return null;
  const { targets, selected, status, refreshing, error, discover, select } = studioTarget;

  const buttonLabel =
    status === "loading"
      ? "Finding Studios…"
      : (selected?.label ?? (status === "empty" ? "No Studios" : "Choose Studio"));

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          posthog.capture(
            "studio_target_picker_opened",
            analyticsProperties("studio_target", { status }),
          );
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
          <MenuLabel>Roblox Studio</MenuLabel>
          <button
            type="button"
            onClick={() => void discover()}
            disabled={status === "loading" || refreshing || selectingKey !== null}
            className="mr-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
          <p className="px-2 pb-2 text-xs leading-relaxed text-muted-foreground">
            No open Studio windows yet. Open a place in Studio, then refresh.
          </p>
        ) : status === "error" ? (
          <div className="px-2 pb-2">
            <p className="text-sm">Couldn’t find Studios</p>
            <p
              className="mt-0.5 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground"
              title={error ?? undefined}
            >
              {error ?? "The Studio integration could not be initialized."}
            </p>
          </div>
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
