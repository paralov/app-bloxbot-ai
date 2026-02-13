import { useEffect, useRef, useState } from "react";
import { useStore } from "@/stores/opencode";

/**
 * A persistent flyout banner that shows the MCP connection URL until
 * Roblox Studio connects for the first time in this app session.
 *
 * - Appears in the bottom-right corner once `mcpUrl` is available
 * - Auto-dismissed when `studioStatus` transitions to `"connected"`
 * - Manually dismissible via the X button
 */
function ConnectionBanner() {
  const studioStatus = useStore((s) => s.studioStatus);
  const mcpUrl = useStore((s) => s.mcpUrl);
  const [dismissed, setDismissed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Track "ever connected" via a ref — no re-render needed since
  // studioStatus already triggers the re-render that checks this.
  const everConnectedRef = useRef(false);
  if (studioStatus === "connected") {
    everConnectedRef.current = true;
  }

  // Clean up copy timeout on unmount
  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  // Don't show if:
  // - no URL available yet
  // - user manually dismissed
  // - Studio has connected at least once this session
  if (!mcpUrl || dismissed || everConnectedRef.current) {
    return null;
  }

  async function handleCopy() {
    if (!mcpUrl) return;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may fail
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-lg border bg-card p-3 shadow-lg">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
            <span className="text-xs font-medium text-foreground">Connect Roblox Studio</span>
          </div>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Dismiss"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Instructions */}
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Paste this URL into the BloxBot Studio plugin to connect:
        </p>

        {/* Copyable URL */}
        <button
          type="button"
          onClick={handleCopy}
          className="mt-2 flex w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1.5 text-left transition-colors hover:bg-muted"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
            {mcpUrl}
          </span>
          <span className="shrink-0 text-[10px] font-medium text-muted-foreground">
            {copied ? "Copied!" : "Copy"}
          </span>
        </button>
      </div>
    </div>
  );
}

export default ConnectionBanner;
