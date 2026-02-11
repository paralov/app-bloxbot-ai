interface LoadingScreenProps {
  message?: string;
  detail?: string;
  /** When provided, shows a retry button instead of the dot loader. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Full-screen loading state featuring the animated BloxBot face.
 * Used during server startup and SDK initialization.
 */
function LoadingScreen({
  message = "Starting up...",
  detail,
  onRetry,
  retrying,
}: LoadingScreenProps) {
  const showError = !!onRetry && !retrying;

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
          className={showError ? "" : "bloxbot-face"}
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
            className={showError ? "" : "bloxbot-eye"}
            x="144"
            y="176"
            width="72"
            height="72"
            rx="24"
            fill="var(--background)"
          />

          {/* Right eye */}
          <rect
            className={showError ? "" : "bloxbot-eye"}
            x="296"
            y="176"
            width="72"
            height="72"
            rx="24"
            fill="var(--background)"
          />

          {/* Smile (happy) or frown (error) */}
          {showError ? (
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

        {/* Retry button or dot loader */}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {retrying ? "Restarting..." : "Try Again"}
          </button>
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

export default LoadingScreen;
