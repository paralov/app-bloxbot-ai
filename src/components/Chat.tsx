import { Boxes, Play } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import ChatInput from "@/components/ChatInput";
import ChatMessages from "@/components/ChatMessages";
import ChatSidebar from "@/components/ChatSidebar";
import Explorer from "@/components/Explorer";
import LoadingScreen from "@/components/LoadingScreen";
import PlaytestPanel from "@/components/PlaytestPanel";
import StudioSetup from "@/components/StudioSetup";
import StudioTargetPicker from "@/components/StudioTargetPicker";
import { useCreateSession } from "@/hooks/mutations/useCreateSession";
import { useSessionStatus } from "@/hooks/useSessionStatuses";
import { useSessions } from "@/hooks/useSessions";
import { useStudioConnection } from "@/hooks/useStudioConnection";
import { analyticsProperties, POSTHOG_PROJECT_TOKEN } from "@/lib/analytics";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const Settings = lazy(() => import("@/components/Settings"));

function Chat() {
  const { ready, initError } = useOpenCodeClient();
  const { activeSessionId, clearSession } = useActiveSession();
  const sessionStatus = useSessionStatus(activeSessionId);
  const isBusy = sessionStatus !== undefined && sessionStatus.type !== "idle";
  const createSession = useCreateSession();
  const { data: allSessions } = useSessions();
  const studioConnection = useStudioConnection();
  const studioTarget = useStudioTargetOptional();
  const hasStudioTarget = studioTarget?.selected !== null && studioTarget?.status === "ready";

  // Get active session title from the sessions list
  const activeSessionTitle = allSessions?.find((s) => s.id === activeSessionId)?.title ?? null;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStudioSetup, setShowStudioSetup] = useState(false);
  const [showPlaytest, setShowPlaytest] = useState(false);
  const sidePanelOpen = showPlaytest || (hasStudioTarget && !explorerCollapsed);
  const desiredSidePanel = showPlaytest
    ? "playtest"
    : hasStudioTarget && !explorerCollapsed
      ? "explorer"
      : null;
  const [renderedSidePanel, setRenderedSidePanel] = useState<"explorer" | "playtest" | null>(null);
  const [sidePanelExiting, setSidePanelExiting] = useState(false);
  const sidePanelTimerRef = useRef<number | null>(null);

  const appScreen =
    showStudioSetup || studioConnection.state === "waiting"
      ? "studio-setup"
      : studioConnection.state === "checking"
        ? "studio-checking"
        : showSettings
          ? "settings"
          : !ready
            ? "loading"
            : activeSessionId
              ? "chat"
              : "home";

  useEffect(() => {
    if (!import.meta.env.PROD || !POSTHOG_PROJECT_TOKEN) return;

    const screenProperties = {
      $current_url: `bloxbot://app/${appScreen}`,
      $host: "app",
      $pathname: `/${appScreen}`,
      app_screen: appScreen,
    };
    posthog.register(screenProperties);
    posthog.capture("$pageview", analyticsProperties("navigation", screenProperties));
  }, [appScreen]);

  useEffect(() => {
    if (studioConnection.state === "waiting") setShowStudioSetup(true);
  }, [studioConnection.state]);

  useEffect(() => {
    if (
      activeSessionId &&
      allSessions &&
      !allSessions.some((session) => session.id === activeSessionId)
    ) {
      clearSession();
    }
  }, [activeSessionId, allSessions, clearSession]);

  useEffect(() => {
    if (sidePanelTimerRef.current !== null) {
      window.clearTimeout(sidePanelTimerRef.current);
      sidePanelTimerRef.current = null;
    }
    if (desiredSidePanel === renderedSidePanel) {
      setSidePanelExiting(false);
      return;
    }
    if (renderedSidePanel !== null) {
      setSidePanelExiting(true);
      sidePanelTimerRef.current = window.setTimeout(() => {
        setRenderedSidePanel(desiredSidePanel);
        setSidePanelExiting(false);
        sidePanelTimerRef.current = null;
      }, 180);
      return;
    }
    setRenderedSidePanel(desiredSidePanel);
    setSidePanelExiting(false);
  }, [desiredSidePanel, renderedSidePanel]);

  useEffect(
    () => () => {
      if (sidePanelTimerRef.current !== null) window.clearTimeout(sidePanelTimerRef.current);
    },
    [],
  );

  const handleToggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const handleSessionSelect = useCallback(() => setShowSettings(false), []);
  const handleOpenSettings = useCallback(() => setShowSettings(true), []);
  const handleToggleExplorer = useCallback(() => {
    if (showPlaytest) {
      posthog.capture("playtest_closed", analyticsProperties("playtest"));
      setShowPlaytest(false);
      setExplorerCollapsed(false);
      return;
    }

    setExplorerCollapsed((collapsed) => !collapsed);
  }, [showPlaytest]);
  const handleOpenPlaytest = useCallback(() => {
    if (!hasStudioTarget) return;
    posthog.capture("playtest_opened", analyticsProperties("playtest"));
    setExplorerCollapsed(true);
    setShowPlaytest(true);
  }, [hasStudioTarget]);
  const handleClosePlaytest = useCallback(() => {
    posthog.capture("playtest_closed", analyticsProperties("playtest"));
    setShowPlaytest(false);
  }, []);

  // Main chat UI
  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggle={handleToggleSidebar}
        onSessionSelect={handleSessionSelect}
        onOpenSettings={handleOpenSettings}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {showStudioSetup || studioConnection.state === "waiting" ? (
          <StudioSetup
            connected={studioConnection.state === "connected"}
            checking={studioConnection.checking}
            onCheck={() => studioConnection.checkAgain()}
            onContinue={() => setShowStudioSetup(false)}
          />
        ) : studioConnection.state === "checking" ? (
          <LoadingScreen message="Finding Roblox Studio" animation="dots" />
        ) : showSettings ? (
          <Suspense fallback={<LoadingScreen message="Loading settings..." />}>
            <Settings onClose={handleSessionSelect} />
          </Suspense>
        ) : !ready ? (
          <LoadingScreen message="Initializing..." />
        ) : !activeSessionId ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="animate-fade-in-up text-center">
              <h2 className="font-serif text-2xl italic text-foreground">
                What would you like to build?
              </h2>
              <p className="mt-2 max-w-md text-xs text-muted-foreground">
                Create a new session or pick one from the sidebar to continue where you left off.
              </p>
              <button
                onClick={() => createSession.mutate()}
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
            </div>
          </div>
        ) : (
          <>
            <div className="flex h-10 shrink-0 items-center border-b px-4">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <h3 className="truncate text-xs font-semibold">
                  {activeSessionTitle || "Untitled"}
                </h3>
                {isBusy && (
                  <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                    {sessionStatus?.type === "retry" ? "Waiting to retry" : "Working"}
                  </span>
                )}
              </div>
              <div className="ml-3 flex w-96 shrink-0 items-center justify-end gap-2">
                <StudioTargetPicker />
                {hasStudioTarget ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={handleToggleExplorer}
                      className="inline-flex h-7 items-center rounded-md border bg-background px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-accent hover:text-foreground"
                      aria-pressed={!explorerCollapsed}
                      title={explorerCollapsed ? "Open Explorer" : "Close Explorer"}
                    >
                      <Boxes aria-hidden="true" size={13} />
                      <span
                        className={`overflow-hidden whitespace-nowrap transition-[max-width,margin,opacity] duration-200 ${sidePanelOpen ? "ml-0 max-w-0 opacity-0" : "ml-1.5 max-w-16 opacity-100"}`}
                      >
                        Explorer
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenPlaytest}
                      disabled={isBusy}
                      className="inline-flex h-7 items-center rounded-md bg-foreground px-2 text-[11px] font-semibold text-background transition-opacity hover:opacity-85 disabled:opacity-40"
                      title={isBusy ? "Wait for the agent to finish" : "Create a playtest plan"}
                    >
                      <Play aria-hidden="true" size={13} fill="currentColor" />
                      <span
                        className={`overflow-hidden whitespace-nowrap transition-[max-width,margin,opacity] duration-200 ${sidePanelOpen ? "ml-0 max-w-0 opacity-0" : "ml-1.5 max-w-16 opacity-100"}`}
                      >
                        Playtest
                      </span>
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <ChatMessages />
            <ChatInput />
          </>
        )}

        {initError && (
          <div className="shrink-0 border-t border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
            {initError}
          </div>
        )}
      </div>
      {renderedSidePanel && activeSessionId && !showSettings && !showStudioSetup ? (
        <div
          className={`flex w-72 shrink-0 overflow-hidden ${sidePanelExiting ? "animate-side-panel-out" : "animate-side-panel-in"}`}
        >
          {renderedSidePanel === "explorer" ? (
            <Explorer
              key={`${activeSessionId}:${studioTarget?.selected?.key ?? "unselected"}`}
              collapsed={false}
              sessionBusy={isBusy}
              onToggle={() => setExplorerCollapsed(true)}
            />
          ) : (
            <PlaytestPanel onClose={handleClosePlaytest} />
          )}
        </div>
      ) : null}
    </div>
  );
}

export default Chat;
