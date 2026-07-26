import { useRef, useState } from "react";

import { desktop } from "@/lib/desktop";
import type { UpdateInfo } from "@/types/desktop";

interface LoadingScreenProps {
  message?: string;
  detail?: string;
  /** Full diagnostic text, hidden behind a disclosure in the error state. */
  technicalDetail?: string;
  animation?: StartupAnimation;
  startup?: StartupProgress;
  /** When true, shows the error state with help actions instead of the dot loader. */
  error?: boolean;
  /** Called when the user clicks "Try Again". */
  onRetry?: () => void;
  /** When true, shows a spinner on the retry button. */
  retrying?: boolean;
}

export type StartupAnimation = "sparkles" | "dots" | "blocks";

export interface StartupProgress {
  step: 1 | 2 | 3;
  label: string;
  progress?: number;
  meta?: string;
}

type UpdateCheckStatus = "idle" | "checking" | "available" | "downloading" | "up-to-date" | "error";

/**
 * Full-screen loading state featuring the animated BloxBot face.
 * Used during server startup and SDK initialization.
 *
 * When `error` is true, shows a sad face with a "Check for Updates"
 * button and a link to the BloxBot website for support.
 */
function LoadingScreen({
  message = "Starting up...",
  detail,
  technicalDetail,
  animation,
  startup,
  error,
  onRetry,
  retrying,
}: LoadingScreenProps) {
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const updateRef = useRef<UpdateInfo | null>(null);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    try {
      const update = await desktop.checkForUpdate();
      if (!update) {
        setUpdateStatus("up-to-date");
        return;
      }
      updateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateStatus("available");
    } catch (err) {
      console.error("[loading] Failed to check for updates:", err);
      setUpdateStatus("error");
    }
  }

  async function handleInstall() {
    const update = updateRef.current;
    if (!update) return;
    try {
      setUpdateStatus("downloading");
      await desktop.installUpdate();
    } catch (err) {
      console.error("[loading] Failed to install update:", err);
      setUpdateStatus("error");
    }
  }

  async function handleCopyDetails() {
    if (!technicalDetail) return;
    try {
      await navigator.clipboard.writeText(technicalDetail);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div
        className="animate-fade-in flex w-full max-w-sm flex-col items-center"
        role={error ? "alert" : undefined}
        aria-live={error ? "assertive" : undefined}
      >
        {/* BloxBot face  - inline SVG so we can animate individual parts */}
        <svg
          width="80"
          height="80"
          viewBox="0 0 512 512"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={error ? "" : "bloxbot-face"}
          aria-hidden="true"
        >
          {/* Body */}
          <rect
            x="32"
            y="32"
            width="448"
            height="448"
            rx="112"
            fill="currentColor"
            className="text-foreground"
          />

          {/* Left eye */}
          <rect
            className={error ? "" : "bloxbot-eye"}
            x="144"
            y="176"
            width="72"
            height="72"
            rx="24"
            fill="var(--background)"
          />

          {/* Right eye */}
          <rect
            className={error ? "" : "bloxbot-eye"}
            x="296"
            y="176"
            width="72"
            height="72"
            rx="24"
            fill="var(--background)"
          />

          {/* Smile (happy) or frown (error) */}
          {error ? (
            <path
              d="M176 368C176 368 208 332 256 332C304 332 336 368 336 368"
              stroke="var(--background)"
              strokeWidth="32"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M168 328C168 328 204.8 376 256 376C307.2 376 344 328 344 328"
              stroke="var(--background)"
              strokeWidth="32"
              strokeLinecap="round"
            />
          )}
        </svg>

        {/* Status text */}
        <h1 className="mt-5 text-base font-semibold text-foreground">{message}</h1>

        {detail && (
          <p className="mt-2 max-w-sm text-center text-xs leading-relaxed text-muted-foreground">
            {detail}
          </p>
        )}

        {/* Error state: help actions */}
        {error ? (
          <div className="mt-5 flex flex-col items-center gap-3">
            {/* Retry button */}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {retrying ? (
                  <>
                    <svg
                      className="h-3.5 w-3.5 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                    </svg>
                    Restarting...
                  </>
                ) : (
                  <>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 2v6h-6" />
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M3 22v-6h6" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                    Restart setup
                  </>
                )}
              </button>
            )}

            {/* Secondary actions  - text links only */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {updateStatus === "idle" && (
                <button
                  type="button"
                  onClick={handleCheckForUpdates}
                  className="underline transition-colors hover:text-foreground"
                >
                  Check for updates
                </button>
              )}

              {updateStatus === "checking" && (
                <span className="flex items-center gap-1.5">
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                  Checking...
                </span>
              )}

              {updateStatus === "up-to-date" && (
                <span className="text-emerald-600">Up to date</span>
              )}

              {updateStatus === "available" && updateVersion && (
                <button
                  type="button"
                  onClick={handleInstall}
                  className="underline transition-colors hover:text-foreground"
                >
                  Install v{updateVersion} &amp; restart
                </button>
              )}

              {updateStatus === "downloading" && (
                <span className="flex items-center gap-1.5">
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                  Installing...
                </span>
              )}

              {updateStatus === "error" && (
                <button
                  type="button"
                  onClick={handleCheckForUpdates}
                  className="underline transition-colors hover:text-foreground"
                >
                  Retry update check
                </button>
              )}

              <span className="text-muted-foreground/40">|</span>

              <a
                href="https://bloxbot.ai"
                target="_blank"
                rel="noreferrer"
                className="underline transition-colors hover:text-foreground"
              >
                Get help
              </a>
            </div>

            {technicalDetail && (
              <details className="mt-1 w-full max-w-sm rounded-lg border bg-card text-left text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none px-3 py-2.5 font-medium text-foreground/75 transition-colors hover:text-foreground">
                  Technical details
                </summary>
                <div className="border-t px-3 py-3">
                  <p className="leading-relaxed">
                    Share these details if support asks for them. They may include local file paths.
                  </p>
                  <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed text-foreground/70">
                    {technicalDetail}
                  </pre>
                  <button
                    type="button"
                    onClick={handleCopyDetails}
                    className="mt-2 font-medium text-foreground/70 underline transition-colors hover:text-foreground"
                  >
                    {copyStatus === "copied"
                      ? "Copied"
                      : copyStatus === "error"
                        ? "Couldn't copy"
                        : "Copy details"}
                  </button>
                </div>
              </details>
            )}
          </div>
        ) : startup ? (
          <StartupProgressGraphic startup={startup} />
        ) : animation ? (
          <StartupAnimationGraphic animation={animation} />
        ) : (
          <div className="mt-4 flex gap-1">
            <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/25" />
            <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/25 [animation-delay:150ms]" />
            <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/25 [animation-delay:300ms]" />
          </div>
        )}
      </div>
    </div>
  );
}

function StartupProgressGraphic({ startup }: { startup: StartupProgress }) {
  const currentIndex = startup.step - 1;
  const currentProgress =
    startup.progress === undefined ? undefined : Math.min(1, Math.max(0, startup.progress));

  return (
    <div className="mt-5 w-full max-w-[17rem]">
      <div
        className="grid grid-cols-3 gap-1.5"
        role="progressbar"
        aria-label={`${startup.label}, step ${startup.step} of 3`}
        aria-valuemin={currentProgress === undefined ? undefined : 0}
        aria-valuemax={currentProgress === undefined ? undefined : 100}
        aria-valuenow={
          currentProgress === undefined ? undefined : Math.round(currentProgress * 100)
        }
      >
        {[0, 1, 2].map((index) => {
          const complete = index < currentIndex;
          const current = index === currentIndex;
          const fill = complete ? 1 : current ? currentProgress : 0;

          return (
            <span
              key={index}
              className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
              aria-hidden="true"
            >
              {current && fill === undefined ? (
                <span className="startup-progress-indeterminate block h-full rounded-full bg-foreground/65" />
              ) : (
                <span
                  className="block h-full origin-left rounded-full bg-foreground/65 transition-transform duration-300 ease-out"
                  style={{ transform: `scaleX(${fill ?? 0})` }}
                />
              )}
            </span>
          );
        })}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
        <span>
          Step {startup.step} of 3 · {startup.label}
        </span>
        {startup.meta && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-foreground/65">
            {startup.meta}
          </span>
        )}
      </div>
    </div>
  );
}

function StartupAnimationGraphic({ animation }: { animation: StartupAnimation }) {
  if (animation === "sparkles") {
    return (
      <div className="startup-sparkles mt-5" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  }

  if (animation === "dots") {
    return (
      <div className="startup-connecting mt-5" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <div className="startup-blocks mt-5" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

export default LoadingScreen;
