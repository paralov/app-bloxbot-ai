import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import ChatInput from "@/components/ChatInput";
import ChatMessages from "@/components/ChatMessages";
import ChatSetup from "@/components/ChatSetup";
import ChatSidebar from "@/components/ChatSidebar";
import LoadingScreen from "@/components/LoadingScreen";
import Settings from "@/components/Settings";
import { useStore } from "@/stores/opencode";

function Chat() {
  const status = useStore((s) => s.status);
  const activeSession = useStore((s) => s.activeSession);
  const isBusy = useStore((s) => s.isBusy);
  const ready = useStore((s) => s.ready);
  const connectedProviders = useStore((s) => s.connectedProviders);
  const initError = useStore((s) => s.initError);
  const hasLaunched = useStore((s) => s.hasLaunched);
  const createSession = useStore((s) => s.createSession);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const serverRunning = status === "Running";
  const isError = typeof status === "object" && "Error" in status;

  async function handleRetry() {
    setRestarting(true);
    try {
      await invoke("restart_opencode");
    } catch (err) {
      console.error("[chat] restart_opencode failed:", err);
    } finally {
      setRestarting(false);
    }
  }

  // ── Still loading persisted state from disk ─────────────────────────
  // hasLaunched is null until init() finishes reading the Tauri store.
  // Show the loading screen to avoid flashing the welcome screen.
  if (hasLaunched === null) {
    return <LoadingScreen message="Starting up..." />;
  }

  // ── First-run welcome screen ─────────────────────────────────────────
  if (hasLaunched === false) {
    return <ChatSetup />;
  }

  // ── Waiting for the backend to start OpenCode ────────────────────────
  if (!serverRunning) {
    return (
      <LoadingScreen
        message={isError ? "Something went wrong" : "Starting up..."}
        detail={isError ? status.Error : undefined}
        error={isError}
        onRetry={isError ? handleRetry : undefined}
        retrying={restarting}
      />
    );
  }

  // ── Main chat UI ─────────────────────────────────────────────────────
  return (
    <div className="flex min-h-0 flex-1">
      {/* Sidebar */}
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onSessionSelect={() => setShowSettings(false)}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {showSettings ? (
          <Settings onClose={() => setShowSettings(false)} />
        ) : !ready ? (
          <LoadingScreen message="Initializing..." />
        ) : !activeSession ? (
          // No session selected
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="animate-fade-in-up text-center">
              {connectedProviders.length === 0 ? (
                <>
                  <h2 className="font-serif text-2xl italic text-foreground">
                    Connect a provider to get started
                  </h2>
                  <p className="mt-2 max-w-sm text-xs text-muted-foreground">
                    You need at least one AI provider connected before you can start chatting.
                  </p>
                  <button
                    onClick={() => setShowSettings(true)}
                    className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Connect Provider
                  </button>
                </>
              ) : (
                <>
                  <h2 className="font-serif text-2xl italic text-foreground">
                    What would you like to build?
                  </h2>
                  <p className="mt-2 max-w-md text-xs text-muted-foreground">
                    Create a new session or pick one from the sidebar to continue where you left
                    off.
                  </p>
                  <button
                    onClick={createSession}
                    className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-5 text-sm font-medium text-background transition-opacity hover:opacity-90"
                  >
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    New Session
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          // Active session -- show messages + input
          <>
            {/* Session header */}
            <div className="flex h-10 shrink-0 items-center justify-between border-b px-4">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-xs font-semibold">
                  {activeSession.title || "Untitled"}
                </h3>
                {isBusy && (
                  <span className="flex items-center gap-1 text-[10px] text-amber-600">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    Working
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {activeSession.id.slice(0, 8)}
              </div>
            </div>

            <ChatMessages />
            <ChatInput />
          </>
        )}

        {/* Error banner */}
        {initError && (
          <div className="shrink-0 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
            {initError}
          </div>
        )}
      </div>
    </div>
  );
}

export default Chat;
