import { useEffect, useRef, useState } from "react";
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
    description: "Open Roblox Studio and connect the BloxBot plugin from the Plugins tab.",
  },
  failed: {
    dot: "bg-red-400",
    label: "MCP server unreachable",
    description:
      "The Roblox Studio bridge is not responding. Another process may be blocking the port.",
  },
  disabled: {
    dot: "bg-stone-300",
    label: "Plugin disabled",
    description: "The Roblox Studio integration is disabled in the configuration.",
  },
  needs_auth: {
    dot: "bg-amber-400",
    label: "MCP needs auth",
    description: "The MCP server requires authentication. Configure it in Settings > Studio.",
  },
  unknown: {
    dot: "bg-stone-300 animate-pulse",
    label: "Checking connection...",
    description: "Waiting for the MCP server to report its status.",
  },
};

function CopyableUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API may fail in some contexts
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="mt-1.5 flex w-full items-center gap-1.5 rounded-md border bg-muted/50 px-2 py-1 text-left transition-colors hover:bg-muted"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground">{url}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {copied ? "Copied!" : "Copy"}
      </span>
    </button>
  );
}

function StudioStatus() {
  const studioStatus = useStore((s) => s.studioStatus);
  const studioError = useStore((s) => s.studioError);
  const mcpUrl = useStore((s) => s.mcpUrl);
  const pluginInstalled = useStore((s) => s.pluginInstalled);
  const installPlugin = useStore((s) => s.installPlugin);
  const restartMcpServer = useStore((s) => s.restartMcpServer);
  const [hovering, setHovering] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const config = STATUS_CONFIG[studioStatus];

  // Show the URL in the popover when MCP is running (connected or waiting for Studio)
  const showUrl = mcpUrl && (studioStatus === "connected" || studioStatus === "disconnected");

  // Clean up pending timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

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

  async function handleRestart() {
    setRestarting(true);
    try {
      await restartMcpServer();
    } catch {
      // Error logged by store
    } finally {
      setRestarting(false);
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
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border bg-popover p-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`} />
            <span className="text-xs font-medium text-foreground">{config.label}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {config.description}
          </p>
          {showUrl && (
            <div className="mt-2">
              <p className="text-[10px] text-muted-foreground">Connection URL:</p>
              <CopyableUrl url={mcpUrl} />
            </div>
          )}
          {studioStatus === "failed" && (
            <div className="mt-2">
              {studioError && (
                <p className="mb-2 rounded bg-red-50 px-2 py-1 font-mono text-[10px] text-red-600">
                  {studioError}
                </p>
              )}
              <button
                type="button"
                onClick={handleRestart}
                disabled={restarting}
                className="inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-foreground text-[11px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {restarting ? "Restarting..." : "Restart MCP Server"}
              </button>
            </div>
          )}
          {studioStatus === "disconnected" && (
            <div className="mt-2">
              {pluginInstalled === false ? (
                <button
                  type="button"
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
                  <li>
                    3. Click the <strong>Plugins</strong> tab
                  </li>
                  <li>
                    4. Open the MCP plugin and click <strong>Connect</strong>
                  </li>
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
