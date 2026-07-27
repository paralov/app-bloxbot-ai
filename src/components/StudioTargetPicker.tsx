import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";

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
  const { targets, selected, status, selectingKey, error, discover, select } = studioTarget;

  const buttonLabel =
    status === "loading"
      ? "Finding Studios…"
      : (selected?.label ?? (status === "empty" ? "No Studios" : "Choose Studio"));

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() =>
          setOpen((value) => {
            if (!value) posthog.capture("studio_target_picker_opened");
            return !value;
          })
        }
        className="flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <StudioIcon />
        <span className="truncate">{buttonLabel}</span>
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
          className="absolute right-0 top-9 z-40 w-80 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div>
              <h4 className="text-sm font-semibold">Target Studio</h4>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                Explorer and new chat actions use this window.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void discover()}
              disabled={status === "loading" || selectingKey !== null}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
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
                  Open a place and enable Studio’s MCP server, then refresh.
                </p>
              </div>
            ) : status === "error" ? (
              <div className="px-4 py-7 text-center">
                <p className="text-sm font-medium">Couldn’t find Studios</p>
                <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                  Check that Studio is open and try again.
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
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${active ? "bg-accent" : "hover:bg-accent/70"}`}
                    >
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${active ? "border-foreground/20 bg-background text-foreground" : "bg-muted text-muted-foreground"}`}
                      >
                        <StudioIcon />
                      </span>
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
          {error ? (
            <div
              role="alert"
              className="border-t border-red-200 bg-red-50 px-4 py-2.5 text-[10px] leading-4 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
