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
  const reportStudioUse = studioTarget?.reportStudioUse;
  const studioStatus = studioTarget?.status;
  const started = studioUse?.started;
  const usedStudio = studioUse?.usedStudio;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the report waits for saved places, which the status follows
  useEffect(() => {
    if (started === undefined || usedStudio === undefined) return;
    reportStudioUse?.({ started, usedStudio });
  }, [reportStudioUse, started, usedStudio, studioStatus]);
  const hasSelectedStudio = studioTarget?.selected != null && studioTarget.status === "ready";
  // A chat whose place closed keeps its Explorer, which says what happened and comes back with it.
  const hasStudioTarget =
    hasSelectedStudio || (!!studioTarget?.missing && studioTarget.status !== "loading");

  // Get active session title from the sessions list
  const activeSessionTitle = allSessions?.find((s) => s.id === activeSessionId)?.title ?? null;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Null until someone says. It opens by itself once a chat is about Studio, not just for one being
  // open, since it takes a lot of room from a chat about a website.
  const [explorerChoices, setExplorerChoices] = useState<Record<string, boolean>>({});
  const explorerChoice = activeSessionId ? (explorerChoices[activeSessionId] ?? null) : null;
  const setExplorerChoice = useCallback(
    (open: boolean) => {
      if (!activeSessionId) return;
      setExplorerChoices((choices) => ({ ...choices, [activeSessionId]: open }));
    },
    [activeSessionId],
  );
  const explorerCollapsed = !(
    explorerChoice ??
    (usedStudio === true || studioTarget?.missing != null || studioTarget?.studioChosen === true)
  );
  const [showSettings, setShowSettings] = useState(false);
  const [titlebarActions, setTitlebarActions] = useState<HTMLElement | null>(null);
  useEffect(() => setTitlebarActions(document.getElementById("titlebar-actions")), []);
  const [showStudioSetup, setShowStudioSetup] = useState(false);
  // From the picker the helper is already connected, so setup is done only once a Studio shows up.
  const [setupFromPicker, setSetupFromPicker] = useState(false);
  const [pickerRequest, setPickerRequest] = useState(0);
  const newChatRef = useRef<HTMLButtonElement>(null);
  // Setup is gone and took focus with it, so it goes to the message box, or New chat with no chat open.
  const focusWhatsNext = useCallback(() => {
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLElement>('[aria-label="Message"]');
      (box ?? newChatRef.current)?.focus();
    });
  }, []);
  const explorerToggleRef = useRef<HTMLButtonElement>(null);
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

  // Finishing setup is a decision to start, so it shouldn't need a second click.
  const { mutate: createChat } = createSession;
  const startFirstChat = useCallback(() => {
    if (!activeSessionId) createChat();
  }, [activeSessionId, createChat]);
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
    setShowStudioSetup(false);
    setFocusComposer(true);
    startFirstChat();
    focusWhatsNext();
    posthog.capture("studio_setup_skipped", analyticsProperties("studio_target"));
    void desktop.patchConfig({ studioSetupSkipped: true });
  }, [focusWhatsNext, startFirstChat]);
  // Setup is for getting started. Once connected, Studio closing mustn't take over someone's chat.
  // Going elsewhere from the sidebar leaves setup, until the next launch.
  const [setupLeft, setSetupLeft] = useState(false);
  const everConnected = useRef(false);
  if (studioConnection.state === "connected") everConnected.current = true;
  const needsSetup =
    studioConnection.state === "waiting" &&
    setupSkipped !== true &&
    !everConnected.current &&
    !setupLeft;
  // Choosing a Studio means they're here for it after all, so the guidance can come back.
  const studioChoices = studioTarget?.studioChoices ?? 0;
  useEffect(() => {
    if (studioChoices === 0) return;
    setSetupSkipped((skipped) => {
      if (skipped) void desktop.patchConfig({ studioSetupSkipped: false });
      return skipped ? false : skipped;
    });
  }, [studioChoices]);
  // Choosing to work without Studio once is enough to stop asking on every new chat.
  const handleWorkedWithoutStudio = useCallback(() => {
    setSetupSkipped(true);
    void desktop.patchConfig({ studioSetupSkipped: true });
  }, []);
  // Setup is waiting on a Studio to appear, and nothing else checks with no chat open, or in a
  // chat working without Studio.
  const discoverStudios = studioTarget?.discover;
  const setupWatching = showStudioSetup;
  useEffect(() => {
    if (!setupWatching) return;
    const timer = window.setInterval(() => void discoverStudios?.(), 2_000);
    return () => window.clearInterval(timer);
  }, [setupWatching, discoverStudios]);
  const connectionPending =
    studioConnection.state !== "connected" &&
    (setupSkipped === null || (studioConnection.state === "checking" && !setupSkipped));

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
    if (needsSetup && !connectionPending) setShowStudioSetup(true);
  }, [needsSetup, connectionPending]);

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
  const openPickerAfterSetup = useRef(false);
  const handleCloseStudioSetup = useCallback(() => {
    setSetupFromPicker(false);
    setShowStudioSetup(false);
    // The picker takes focus itself when it's what comes next.
    if (openPickerAfterSetup.current) return;
    setFocusComposer(true);
    focusWhatsNext();
  }, [focusWhatsNext]);
  // The picker isn't on screen until setup has gone, so asking it to open has to wait until then.
  useEffect(() => {
    if (showStudioSetup || !openPickerAfterSetup.current) return;
    openPickerAfterSetup.current = false;
    setPickerRequest((request) => request + 1);
  }, [showStudioSetup]);
  // Connected isn't the end of it if this chat still has to be told which Studio to use.
  const needsStudioChoice =
    // The picker lives in a chat, so with none open there's nothing to choose in yet.
    !!activeSessionId &&
    (studioTarget?.missing != null ||
      studioTarget?.withoutStudio === true ||
      studioTarget?.unknownPlace === true ||
      (!studioTarget?.selected && (studioTarget?.targets.length ?? 0) > 1));
  const leaveSetup = useCallback(() => {
    setSetupLeft(true);
    setSetupFromPicker(false);
    setShowStudioSetup(false);
  }, []);
  const handleSessionSelect = useCallback(() => {
    setShowSettings(false);
    leaveSetup();
  }, [leaveSetup]);
  const handleOpenSettings = useCallback(() => {
    setShowSettings(true);
    leaveSetup();
  }, [leaveSetup]);
  const handleToggleExplorer = useCallback(() => {
    if (showPlaytest) {
      posthog.capture("playtest_closed", analyticsProperties("playtest"));
      setShowPlaytest(false);
      setExplorerChoice(true);
      return;
    }

    setExplorerChoice(explorerCollapsed);
  }, [showPlaytest, explorerCollapsed, setExplorerChoice]);
  const handleOpenPlaytest = useCallback(() => {
    if (!hasStudioTarget) return;
    posthog.capture("playtest_opened", analyticsProperties("playtest"));
    setShowPlaytest(true);
  }, [hasStudioTarget]);
  const handleClosePlaytest = useCallback(() => {
    posthog.capture("playtest_closed", analyticsProperties("playtest"));
    setShowPlaytest(false);
  }, []);

  // One chat's plan shouldn't run in another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each chat starts without it
  useEffect(() => {
    setShowPlaytest(false);
  }, [activeSessionId]);

  // The place closing can take the Explorer away with focus inside it, and without a word.
  const previousPanelRef = useRef(renderedSidePanel);
  const [panelNote, setPanelNote] = useState("");
  useEffect(() => {
    const previous = previousPanelRef.current;
    previousPanelRef.current = renderedSidePanel;
    if (hasStudioTarget) setPanelNote("");
    if (previous !== "explorer" || renderedSidePanel !== null) return;
    if (!hasStudioTarget) setPanelNote("Explorer closed. No Studio is open.");
    if (document.activeElement === document.body) focusWhatsNext();
  }, [renderedSidePanel, hasStudioTarget, focusWhatsNext]);

  // A click on an object in a reply needs the Explorer to be showing.
  const { focusRequest } = useExplorerReference();
  useEffect(() => {
    if (!focusRequest) return;
    setShowPlaytest(false);
    setExplorerChoice(true);
  }, [focusRequest, setExplorerChoice]);

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
                ref={explorerToggleRef}
                type="button"
                onClick={handleToggleExplorer}
                className={`${MENU_TRIGGER} gap-1.5`}
                aria-pressed={!explorerCollapsed && !showPlaytest}
                title={explorerCollapsed ? "Open Explorer" : "Close Explorer"}
              >
                <Boxes aria-hidden="true" size={14} />
                Explorer
              </button>
              {hasSelectedStudio ? (
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
              ) : null}
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
              (!studioTarget || studioTarget.status === "ready")
            }
            checking={studioConnection.checking}
            problem={studioConnection.problem}
            onCheck={() => {
              void studioConnection.checkAgain();
              if (setupFromPicker) void studioTarget?.discover();
            }}
            onContinue={() => {
              if (needsStudioChoice) openPickerAfterSetup.current = true;
              handleCloseStudioSetup();
              startFirstChat();
            }}
            onDismiss={setupFromPicker ? handleCloseStudioSetup : undefined}
            onSkip={setupFromPicker ? undefined : handleSkipSetup}
            needsChoice={needsStudioChoice}
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
                ref={newChatRef}
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
                  onWorkedWithoutStudio={handleWorkedWithoutStudio}
                  openRequest={pickerRequest}
                />
              </div>
            </div>

            <ChatMessages />
            <StudioNotice
              quiet={studioUse?.started === true || setupSkipped === true}
              onWorkedWithoutStudio={handleWorkedWithoutStudio}
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
      <output className="sr-only">{panelNote}</output>
      {renderedSidePanel && activeSessionId && !showSettings && !showStudioSetup ? (
        <div
          className={`flex w-72 shrink-0 overflow-hidden ${sidePanelExiting ? "animate-side-panel-out" : "animate-side-panel-in"}`}
        >
          {renderedSidePanel === "explorer" ? (
            <Explorer
              collapsed={false}
              sessionBusy={isBusy}
              onToggle={() => {
                setExplorerChoice(false);
                explorerToggleRef.current?.focus();
              }}
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
