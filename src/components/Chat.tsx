import { Boxes, Play } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import ChatInput from "@/components/ChatInput";
import ChatMessages from "@/components/ChatMessages";
import ChatSidebar from "@/components/ChatSidebar";
import Explorer from "@/components/Explorer";
import LoadingScreen from "@/components/LoadingScreen";
import PlaytestPanel from "@/components/PlaytestPanel";
import StudioNotice from "@/components/StudioNotice";
import StudioSetup from "@/components/StudioSetup";
import StudioTargetPicker from "@/components/StudioTargetPicker";
import { MENU_TRIGGER } from "@/components/ui/menu";
import { useCreateSession } from "@/hooks/mutations/useCreateSession";
import { useChatStudioUse } from "@/hooks/useMessages";
import { useSessionStatus } from "@/hooks/useSessionStatuses";
import { useSessions } from "@/hooks/useSessions";
import { useStudioConnection } from "@/hooks/useStudioConnection";
import { analyticsProperties, POSTHOG_PROJECT_TOKEN } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { setChatOnScreen, setSessionOpener } from "@/lib/sessionNotifications";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const Settings = lazy(() => import("@/components/Settings"));

function Chat() {
  const { ready, initError } = useOpenCodeClient();
  const { activeSessionId, clearSession, selectSession } = useActiveSession();
  const sessionStatus = useSessionStatus(activeSessionId);
  const isBusy = sessionStatus !== undefined && sessionStatus.type !== "idle";
  const createSession = useCreateSession();
  const { data: allSessions } = useSessions();
  const studioConnection = useStudioConnection();
  const studioTarget = useStudioTargetOptional();
  const studioUse = useChatStudioUse();
  const tieToStudio = studioTarget?.tieToStudio;
  const usingStudioKey = studioTarget?.selected?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again for each Studio it could tie to
  useEffect(() => {
    if (studioUse.usedStudio) tieToStudio?.();
  }, [studioUse.usedStudio, tieToStudio, usingStudioKey]);
  // A chat whose place closed keeps its Explorer, which says what happened and comes back with it.
  const hasStudioTarget =
    (studioTarget?.selected !== null && studioTarget?.status === "ready") ||
    (!!studioTarget?.missing && studioTarget.status !== "loading");

  // Get active session title from the sessions list
  const activeSessionTitle = allSessions?.find((s) => s.id === activeSessionId)?.title ?? null;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [titlebarActions, setTitlebarActions] = useState<HTMLElement | null>(null);
  useEffect(() => setTitlebarActions(document.getElementById("titlebar-actions")), []);
  const [showStudioSetup, setShowStudioSetup] = useState(false);
  // From the picker the helper is already connected, so setup is done only once a Studio shows up.
  const [setupFromPicker, setSetupFromPicker] = useState(false);
  const [pickerRequest, setPickerRequest] = useState(0);
  const [focusComposer, setFocusComposer] = useState(false);
  const [showPlaytest, setShowPlaytest] = useState(false);
  const desiredSidePanel = showPlaytest
    ? "playtest"
    : hasStudioTarget && !explorerCollapsed
      ? "explorer"
      : null;
  const [renderedSidePanel, setRenderedSidePanel] = useState<"explorer" | "playtest" | null>(null);
  const [sidePanelExiting, setSidePanelExiting] = useState(false);
  const sidePanelTimerRef = useRef<number | null>(null);

  // Studio isn't required: BloxBot is also fine for small websites and the like.
  const [setupSkipped, setSetupSkipped] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop.loadConfig().then(
      (config) => setSetupSkipped(config.studioSetupSkipped === true),
      () => setSetupSkipped(false),
    );
  }, []);
  const handleSkipSetup = useCallback(() => {
    setSetupSkipped(true);
    posthog.capture("studio_setup_skipped", analyticsProperties("studio_target"));
    void desktop.patchConfig({ studioSetupSkipped: true });
  }, []);
  const needsSetup = studioConnection.state === "waiting" && setupSkipped !== true;
  const connectionPending =
    studioConnection.state === "checking" ||
    (studioConnection.state === "waiting" && setupSkipped === null);

  const appScreen =
    showStudioSetup || (needsSetup && !connectionPending)
      ? "studio-setup"
      : connectionPending
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
    setChatOnScreen(appScreen === "chat");
  }, [appScreen]);

  useEffect(() => {
    setSessionOpener((sessionID) => {
      setShowSettings(false);
      void selectSession(sessionID);
    });
  }, [selectSession]);

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
  const handleOpenStudioSetup = useCallback(() => {
    setSetupFromPicker(true);
    setShowStudioSetup(true);
  }, []);
  const handleCloseStudioSetup = useCallback(() => {
    setSetupFromPicker(false);
    setShowStudioSetup(false);
    setFocusComposer(true);
  }, []);
  // The picker isn't on screen until setup has gone, so asking it to open has to wait until then.
  const openPickerAfterSetup = useRef(false);
  useEffect(() => {
    if (showStudioSetup || !openPickerAfterSetup.current) return;
    openPickerAfterSetup.current = false;
    setPickerRequest((request) => request + 1);
  }, [showStudioSetup]);
  const placeMissing = studioTarget?.missing != null;
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

  // A click on an object in a reply needs the Explorer to be showing.
  const { focusRequest } = useExplorerReference();
  useEffect(() => {
    if (!focusRequest) return;
    setShowPlaytest(false);
    setExplorerCollapsed(false);
  }, [focusRequest]);

  // Settings brings its own sidebar, so the chat list steps aside for it.
  if (showSettings && !showStudioSetup && !needsSetup && !connectionPending) {
    return (
      <div className="flex min-h-0 flex-1 bg-sidebar">
        <Suspense fallback={<LoadingScreen message="Loading settings..." />}>
          <Settings onClose={handleSessionSelect} />
        </Suspense>
      </div>
    );
  }

  // Main chat UI
  return (
    <div className="flex min-h-0 flex-1 bg-sidebar">
      {titlebarActions && appScreen === "chat" && hasStudioTarget
        ? createPortal(
            <>
              <button
                type="button"
                onClick={handleToggleExplorer}
                className={`${MENU_TRIGGER} gap-1.5`}
                aria-pressed={!explorerCollapsed && !showPlaytest}
                title={explorerCollapsed ? "Open Explorer" : "Close Explorer"}
              >
                <Boxes aria-hidden="true" size={14} />
                Explorer
              </button>
              <button
                type="button"
                onClick={handleOpenPlaytest}
                disabled={isBusy || !!studioTarget?.sendBlock}
                className={`${MENU_TRIGGER} gap-1.5`}
                aria-pressed={showPlaytest}
                title={
                  studioTarget?.sendBlock ??
                  (isBusy ? "Wait for the agent to finish" : "Create a playtest plan")
                }
              >
                <Play aria-hidden="true" size={14} fill="currentColor" />
                Playtest
              </button>
            </>,
            titlebarActions,
          )
        : null}
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggle={handleToggleSidebar}
        onSessionSelect={handleSessionSelect}
        onOpenSettings={handleOpenSettings}
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-t-xl border-x border-t bg-background">
        {showStudioSetup || (needsSetup && !connectionPending) ? (
          <StudioSetup
            connected={
              studioConnection.state === "connected" &&
              (!setupFromPicker || studioTarget?.status === "ready")
            }
            checking={studioConnection.checking}
            problem={studioConnection.problem}
            onCheck={() => {
              void studioConnection.checkAgain();
              if (setupFromPicker) void studioTarget?.discover();
            }}
            onContinue={() => {
              handleCloseStudioSetup();
              if (placeMissing) {
                openPickerAfterSetup.current = true;
                setFocusComposer(false);
              }
            }}
            onDismiss={setupFromPicker ? handleCloseStudioSetup : undefined}
            onSkip={setupFromPicker ? undefined : handleSkipSetup}
            needsChoice={placeMissing}
          />
        ) : connectionPending ? (
          <LoadingScreen message="Finding Roblox Studio" animation="dots" />
        ) : !ready ? (
          <LoadingScreen message="Initializing..." />
        ) : !activeSessionId ? (
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="animate-fade-in-up text-center">
              <h2 className="text-xl font-medium text-foreground">What would you like to build?</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Start a new chat, or pick up where you left off.
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
                New chat
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex h-11 shrink-0 items-center justify-between gap-3 px-3">
              <h3 className="min-w-0 truncate text-lg font-medium">
                {activeSessionTitle || "Untitled"}
              </h3>
              <div className="flex max-w-[45%] shrink-0">
                <StudioTargetPicker
                  onOpenSetup={handleOpenStudioSetup}
                  openRequest={pickerRequest}
                />
              </div>
            </div>

            <ChatMessages />
            <StudioNotice
              chatStarted={studioUse.started}
              onOpenSetup={handleOpenStudioSetup}
              onOpenPicker={() => setPickerRequest((request) => request + 1)}
            />
            <ChatInput onOpenSettings={handleOpenSettings} focusOnMount={focusComposer} />
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
