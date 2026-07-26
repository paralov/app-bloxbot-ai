import posthog from "posthog-js/dist/module.full.no-external.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import ChatInput from "@/components/ChatInput";
import ChatMessages from "@/components/ChatMessages";
import ChatSidebar from "@/components/ChatSidebar";
import LoadingScreen from "@/components/LoadingScreen";
import StudioPlacePicker from "@/components/StudioPlacePicker";
import StudioSetup from "@/components/StudioSetup";
import { useCreateSession } from "@/hooks/mutations/useCreateSession";
import { useSessionStatus } from "@/hooks/useSessionStatuses";
import { useSessions } from "@/hooks/useSessions";
import { staleStudioAssignmentIDs, useStudioAssignments } from "@/hooks/useStudioAssignments";
import { useStudioConnection } from "@/hooks/useStudioConnection";
import { POSTHOG_PROJECT_TOKEN } from "@/lib/analytics";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const Settings = lazy(() => import("@/components/Settings"));

function Chat() {
  const { ready, initError } = useOpenCodeClient();
  const { activeSessionId, clearSession } = useActiveSession();
  const sessionStatus = useSessionStatus(activeSessionId);
  const isBusy = sessionStatus !== undefined && sessionStatus.type !== "idle";
  const createSession = useCreateSession();
  const { data: allSessions } = useSessions();
  const { assignments: studioAssignments, setAssignment } = useStudioAssignments();
  const studioConnection = useStudioConnection();
  const pruneAttempts = useRef(new Map<string, number>());

  // Get active session title from the sessions list
  const activeSessionTitle = allSessions?.find((s) => s.id === activeSessionId)?.title ?? null;

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStudioSetup, setShowStudioSetup] = useState(false);

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
    posthog.capture("$pageview", screenProperties);
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
    if (!allSessions) return;
    const sessionIDs = new Set(allSessions.map((session) => session.id));
    for (const sessionID of staleStudioAssignmentIDs(studioAssignments, sessionIDs)) {
      const attempts = pruneAttempts.current.get(sessionID) ?? 0;
      if (attempts >= 2) continue;
      pruneAttempts.current.set(sessionID, attempts + 1);
      void setAssignment(sessionID, null).catch((error) => {
        toast.error("Old Studio assignment cleanup failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, [allSessions, setAssignment, studioAssignments]);

  const handleToggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const handleSessionSelect = useCallback(() => setShowSettings(false), []);
  const handleOpenSettings = useCallback(() => setShowSettings(true), []);

  // Main chat UI
  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggle={handleToggleSidebar}
        onSessionSelect={handleSessionSelect}
        onOpenSettings={handleOpenSettings}
      />

      <div className="flex min-w-0 flex-1 flex-col">
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
            <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b px-4">
              <div className="flex min-w-0 items-center gap-2">
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
              <StudioPlacePicker sessionID={activeSessionId} disabled={isBusy} />
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
    </div>
  );
}

export default Chat;
