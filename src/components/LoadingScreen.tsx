import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useState } from "react";

interface LoadingScreenProps {
  message?: string;
  detail?: string;
  /** When true, shows the error state with help actions instead of the dot loader. */
  error?: boolean;
  /** Called when the user clicks "Try Again". */
  onRetry?: () => void;
  /** When true, shows a spinner on the retry button. */
  retrying?: boolean;
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
  error,
  onRetry,
  retrying,
}: LoadingScreenProps) {
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const updateRef = useState<Awaited<ReturnType<typeof check>> | null>(null);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("up-to-date");
        return;
      }
      updateRef[1](update);
      setUpdateVersion(update.version);
      setUpdateStatus("available");
    } catch (err) {
      console.error("[loading] Failed to check for updates:", err);
      setUpdateStatus("error");
    }
  }

  async function handleInstall() {
    const update = updateRef[0];
    if (!update) return;
    try {
      setUpdateStatus("downloading");
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      console.error("[loading] Failed to install update:", err);
      setUpdateStatus("error");
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="animate-fade-in flex flex-col items-center">
        {/* BloxBot face — inline SVG so we can animate individual parts */}
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
        <p className="mt-5 text-sm font-medium text-foreground/70">{message}</p>

        {detail && <p className="mt-1.5 max-w-xs text-center text-xs text-destructive">{detail}</p>}

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
                    Try Again
                  </>
                )}
              </button>
            )}

            {/* Secondary actions — text links only */}
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
                bloxbot.ai
              </a>
            </div>
          </div>
        ) : (
          /* Loading state: dot animation */
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

export default LoadingScreen;
