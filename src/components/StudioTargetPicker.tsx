import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

import { analyticsProperties } from "@/lib/analytics";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

function StudioIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 5.5h16v11H4z" />
      <path d="M8 20h8M12 16.5V20" />
    </svg>
  );
}

export default function StudioTargetPicker() {
  const studioTarget = useStudioTargetOptional();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!studioTarget) return null;
  const { targets, selected, status, refreshing, selectingKey, error, discover, select } =
    studioTarget;

  const buttonLabel =
    status === "loading"
      ? "Finding Studios…"
      : (selected?.label ?? (status === "empty" ? "No Studios" : "Choose Studio"));

  return (
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() =>
          setOpen((value) => {
            if (!value) {
              posthog.capture(
                "studio_target_picker_opened",
                analyticsProperties("studio_target", { status }),
              );
            }
            return !value;
          })
        }
        className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="shrink-0">
          <StudioIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{buttonLabel}</span>
        {status === "loading" ? (
          <span className="ml-0.5 h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
        ) : (
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m7 10 5 5 5-5" />
          </svg>
        )}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose Roblox Studio"
          className="animate-picker-in absolute right-0 top-9 z-40 w-[min(20rem,calc(100vw-2rem))] origin-top-right overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex h-11 items-center justify-between gap-3 border-b px-4">
            <h4 className="text-sm font-semibold">Pick Studio</h4>
            <button
              type="button"
              onClick={() => void discover()}
              disabled={status === "loading" || refreshing || selectingKey !== null}
              className="inline-flex min-w-14 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {refreshing ? (
                <span className="h-2.5 w-2.5 animate-spin rounded-full border border-current border-t-transparent" />
              ) : null}
              Refresh
            </button>
          </div>
          <div className="max-h-72 p-2">
            {status === "loading" ? (
              <output className="block space-y-2 p-2" aria-label="Loading Studio targets">
                {[0, 1].map((item) => (
                  <div key={item} className="h-12 animate-pulse rounded-lg bg-muted" />
                ))}
              </output>
            ) : status === "empty" ? (
              <div className="px-4 py-7 text-center">
                <p className="text-sm font-medium">No Studio windows found</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Studio MCP is connected, but it has not reported an open Studio window yet.
                </p>
              </div>
            ) : status === "error" ? (
              <div className="px-4 py-7 text-center">
                <p className="text-sm font-medium">Couldn’t find Studios</p>
                <p
                  className="mt-1 line-clamp-3 break-words text-[11px] leading-4 text-muted-foreground"
                  title={error ?? undefined}
                >
                  {error ?? "The Studio integration could not be initialized."}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {targets.map((target) => {
                  const active = selected?.key === target.key;
                  const selecting = selectingKey === target.key;
                  return (
                    <button
                      key={target.key}
                      type="button"
                      disabled={selectingKey !== null}
                      onClick={() => void select(target)}
                      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-60 ${active ? "bg-accent" : "hover:bg-accent/70"}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{target.label}</span>
                        {target.detail ? (
                          <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                            {target.detail}
                          </span>
                        ) : null}
                      </span>
                      {selecting ? (
                        <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                      ) : active ? (
                        <svg
                          aria-label="Selected"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                        >
                          <path d="m5 12 4 4L19 6" />
                        </svg>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {error && status !== "error" ? (
            <div
              role="alert"
              className="line-clamp-3 break-words border-t border-red-200 bg-red-50 px-4 py-2.5 text-[10px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              title={error}
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
