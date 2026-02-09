import { useRef, useState } from "react";
import { useStore } from "@/stores/opencode";
import type { StudioConnectionStatus } from "@/types";

const STATUS_CONFIG: Record<
  StudioConnectionStatus,
  { dot: string; label: string; description: string }
> = {
  connected: {
    dot: "bg-emerald-400",
    label: "Studio connected",
    description: "Roblox Studio is connected and ready. You can send messages.",
  },
  disconnected: {
    dot: "bg-red-400",
    label: "Studio not connected",
    description:
      "Open Roblox Studio and make sure the BloxBot plugin is installed. The plugin connects automatically when Studio is running.",
  },
  failed: {
    dot: "bg-amber-400 animate-pulse",
    label: "MCP server starting...",
    description:
      "The Roblox Studio bridge is not reachable yet. It usually takes a few seconds to start up after launch.",
  },
  disabled: {
    dot: "bg-stone-300",
    label: "Plugin disabled",
    description: "The Roblox Studio integration is disabled in the configuration.",
  },
  unknown: {
    dot: "bg-stone-300 animate-pulse",
    label: "Checking connection...",
    description: "Waiting for the MCP server to report its status.",
  },
};

function StudioStatus() {
  const studioStatus = useStore((s) => s.studioStatus);
  const studioError = useStore((s) => s.studioError);
  const pluginInstalled = useStore((s) => s.pluginInstalled);
  const installPlugin = useStore((s) => s.installPlugin);
  const [hovering, setHovering] = useState(false);
  const [installing, setInstalling] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const config = STATUS_CONFIG[studioStatus];

  function handleEnter() {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setHovering(true);
  }

  function handleLeave() {
    timeoutRef.current = setTimeout(() => setHovering(false), 150);
  }

  async function handleInstall() {
    setInstalling(true);
    try {
      await installPlugin();
    } catch {
      // Error logged by store
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="relative" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {/* Indicator row */}
      <div className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-accent">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${config.dot}`} />
        <span className="text-[11px] text-muted-foreground">{config.label}</span>
      </div>

      {/* Popover */}
      {hovering && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border bg-popover p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`} />
            <span className="text-xs font-medium text-foreground">{config.label}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {config.description}
          </p>
          {studioStatus === "failed" && studioError && (
            <p className="mt-1.5 rounded bg-red-50 px-2 py-1 font-mono text-[10px] text-red-600">
              {studioError}
            </p>
          )}
          {studioStatus === "disconnected" && (
            <div className="mt-2">
              {pluginInstalled === false ? (
                <button
                  onClick={handleInstall}
                  disabled={installing}
                  className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-foreground text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {installing ? "Installing..." : "Install Studio Plugin"}
                </button>
              ) : (
                <ol className="space-y-1 text-[10px] text-muted-foreground">
                  <li>1. Open Roblox Studio</li>
                  <li>2. Open or create a place file</li>
                  <li>3. The plugin will connect automatically</li>
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default StudioStatus;
