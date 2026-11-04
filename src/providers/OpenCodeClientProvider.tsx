import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import LoadingScreen, { type StartupProgress } from "@/components/LoadingScreen";
import { aiTracer, captureDetailedAnalytics } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { createOpencodeClient, type OpencodeClient } from "@/lib/opencode/client";
import { qk } from "@/lib/queryKeys";
import { sessionNotifier } from "@/lib/sessionNotifications";
import { sseDispatch } from "@/lib/sseDispatch";
import type { OpenCodeStartupProgress } from "@/types/desktop";

const SSE_RECONNECT_DELAY = 3000;
const SSE_FAILURE_THRESHOLD = 3;

type AppStatus = "waiting" | "ready" | "error";
export type StartupPhase = "engine" | "connection" | "workspace";

interface StartupPresentation {
  message: string;
  detail: string;
  startup: StartupProgress;
}

interface StartupErrorPresentation {
  helpLink?: { label: string; href: string };
  message: string;
  detail: string;
  /** A folder the person needs, such as one to exclude from antivirus scans. */
  detailPath?: string;
  technicalDetail: string;
}

/** The `(reason: …)` the desktop service adds when installing OpenCode fails. */
export function getInstallFailureReason(technicalDetail: string): string | null {
  return /\(reason: ([a-z_]+)\)/.exec(technicalDetail)?.[1] ?? null;
}

const DEFAULT_ENGINE_PROGRESS: OpenCodeStartupProgress = { phase: "checking" };
const SLOW_STEP_MS = 20_000;
/** Microsoft's steps, which are no use anywhere but Windows. */
function exclusionHelp() {
  return navigator.userAgent.includes("Windows")
    ? {
        label: "How to add an exclusion in Windows Security",
        href: "https://support.microsoft.com/en-us/windows/add-an-exclusion-to-windows-security-811816c0-4dfd-af4a-47e4-c301afe13b26",
      }
    : undefined;
}
const SERVER_WAIT_MS = 60_000;
/** Restarting would only start a slow step's wait over, so it isn't offered right away. */
const TRY_AGAIN_AFTER_MS = 45_000;
/** Past the port wait, since restarting sooner would stop an older copy from ever being tried. */
const TRY_AGAIN_WHILE_STARTING_MS = 130_000;

const STARTUP_COPY: Record<Exclude<StartupPhase, "engine">, StartupPresentation> = {
  connection: {
    message: "Connecting the dots",
    detail: "Making sure everything can talk",
    startup: { step: 2, label: "Connecting" },
  },
  workspace: {
    message: "Setting the stage",
    detail: "Loading your workspace and preferences",
    startup: { step: 3, label: "Opening" },
  },
};

export function formatTransferSpeed(bytesPerSecond: number): string {
  const speed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  if (speed < 1024) return `${Math.round(speed)} B/s`;
  if (speed < 1024 ** 2) return `${(speed / 1024).toFixed(1)} KB/s`;
  return `${(speed / 1024 ** 2).toFixed(1)} MB/s`;
}

function getEnginePresentation(progress: OpenCodeStartupProgress): StartupPresentation {
  if (progress.phase === "downloading") {
    const fraction =
      progress.totalBytes && progress.totalBytes > 0
        ? Math.min(progress.downloadedBytes / progress.totalBytes, 1)
        : undefined;
    const percentage = fraction === undefined ? null : `${Math.round(fraction * 100)}%`;
    return {
      message: "Downloading a one-time setup",
      detail: "Future launches will use the saved copy",
      startup: {
        step: 1,
        label: "Preparing",
        progress: fraction,
        meta: [
          percentage,
          progress.bytesPerSecond > 0 ? formatTransferSpeed(progress.bytesPerSecond) : null,
        ]
          .filter(Boolean)
          .join(" "),
      },
    };
  }

  if (progress.phase === "verifying") {
    return {
      message: "Checking the download",
      detail: "Making sure everything arrived safely",
      startup: { step: 1, label: "Preparing", progress: 1 },
    };
  }

  if (progress.phase === "installing") {
    return {
      message: "Finishing setup",
      detail: "Unpacking the local engine",
      startup: { step: 1, label: "Preparing", progress: 1 },
    };
  }

  if (progress.phase === "starting") {
    return {
      message: "Starting your workspace",
      detail: "Launching the local engine",
      startup: { step: 1, label: "Preparing", progress: 1 },
    };
  }

  return {
    message: "Getting things ready",
    detail: "Checking what this computer needs",
    startup: { step: 1, label: "Preparing" },
  };
}

/** Replaces the usual reassurance when a step has gone quiet, so it doesn't look frozen. */
function slowPresentation(
  presentation: StartupPresentation,
  phase: StartupPhase,
  engineProgress: OpenCodeStartupProgress,
): StartupPresentation {
  const downloading = phase === "engine" && engineProgress.phase === "downloading";
  const scannable =
    phase === "engine" &&
    (engineProgress.phase === "installing" ||
      engineProgress.phase === "verifying" ||
      engineProgress.phase === "starting");
  return {
    ...presentation,
    detail: downloading
      ? "Connection paused. Check your Wi-Fi or security software. BloxBot keeps trying."
      : scannable
        ? "Taking longer than usual. Security software can slow this."
        : "Taking longer than usual. Still trying.",
    // The last speed is out of date by now, but how far it got still holds.
    startup: downloading
      ? {
          ...presentation.startup,
          meta:
            presentation.startup.progress === undefined
              ? undefined
              : `${Math.round(presentation.startup.progress * 100)}%`,
        }
      : presentation.startup,
  };
}

export function getStartupPresentation(
  phase: StartupPhase,
  engineProgress: OpenCodeStartupProgress = DEFAULT_ENGINE_PROGRESS,
  slow = false,
): StartupPresentation {
  const presentation =
    phase === "engine" ? getEnginePresentation(engineProgress) : STARTUP_COPY[phase];
  return slow ? slowPresentation(presentation, phase, engineProgress) : presentation;
}

export function getStartupErrorPresentation(
  error: unknown,
  installFolder: string | null = null,
): StartupErrorPresentation {
  const technicalDetail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const normalized = technicalDetail.toLowerCase();
  const reason = getInstallFailureReason(technicalDetail);

  if (reason === "blocked_by_security") {
    return {
      message: "Setup couldn't finish",
      detail:
        "Security software blocked BloxBot's engine. Add this folder as an exclusion, then try again.",
      detailPath: installFolder ?? undefined,
      helpLink: exclusionHelp(),
      technicalDetail,
    };
  }

  if (reason === "disk_full") {
    return {
      message: "Setup couldn't finish",
      detail: "Your drive is nearly full. Free up at least 500 MB, then try again.",
      technicalDetail,
    };
  }

  if (reason === "other") {
    return {
      message: "Setup couldn't finish",
      detail:
        "BloxBot couldn't set up its engine. Try again, or email support if it keeps failing.",
      technicalDetail,
    };
  }

  if (
    normalized.includes("failed to spawn") ||
    normalized.includes("failed to start opencode") ||
    normalized.includes("exited during startup") ||
    normalized.includes("stopped unexpectedly")
  ) {
    return {
      message: "BloxBot couldn't start",
      detail:
        "Its local engine stopped. Try again. If it keeps stopping, allow this folder in your antivirus.",
      detailPath: installFolder ?? undefined,
      helpLink: exclusionHelp(),
      technicalDetail,
    };
  }

  if (
    normalized.includes("did not open a listening port") ||
    normalized.includes("did not become healthy")
  ) {
    return {
      message: "BloxBot couldn't start",
      detail:
        "Its local engine didn't respond. Allow this folder in your antivirus or pause your VPN, then try again.",
      detailPath: installFolder ?? undefined,
      helpLink: exclusionHelp(),
      technicalDetail,
    };
  }

  if (normalized.includes("certificate")) {
    return {
      message: "Setup couldn't finish",
      detail:
        "A company network or antivirus blocked the download. Try another network, then try again.",
      technicalDetail,
    };
  }

  if (normalized.includes("stalled, no data")) {
    return {
      message: "Setup couldn't finish",
      detail: "The download stopped getting data. Check your connection, then try again.",
      technicalDetail,
    };
  }

  if (
    normalized.includes("github release lookup") ||
    normalized.includes("opencode download") ||
    normalized.includes("verified opencode")
  ) {
    return {
      message: "Setup couldn't finish",
      detail:
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then try again.",
      technicalDetail,
    };
  }

  if (normalized.includes("does not provide a supported binary")) {
    return {
      message: "This computer isn't supported yet",
      detail:
        "BloxBot couldn't find a compatible setup package for this system. Check for an app update or email support.",
      technicalDetail,
    };
  }

  return {
    message: "Setup couldn't finish",
    detail:
      "BloxBot hit a problem while preparing its engine. Try again, or email support if it keeps failing.",
    technicalDetail,
  };
}

interface OpenCodeClientContextValue {
  client: OpencodeClient | null;
  status: AppStatus;
  port: number;
  ready: boolean;
  initError: string | null;
}

export const OpenCodeClientContext = createContext<OpenCodeClientContextValue>({
  client: null,
  status: "waiting",
  port: 0,
  ready: false,
  initError: null,
});

export function useOpenCodeClient() {
  return useContext(OpenCodeClientContext);
}

export function OpenCodeClientProvider({
  children,
  activeSessionIdRef,
}: {
  children: ReactNode;
  activeSessionIdRef: React.RefObject<string | null>;
}) {
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<AppStatus>("waiting");
  const [startupPhase, setStartupPhase] = useState<StartupPhase>("engine");
  const [engineProgress, setEngineProgress] =
    useState<OpenCodeStartupProgress>(DEFAULT_ENGINE_PROGRESS);
  const [port, setPort] = useState(0);
  const [client, setClient] = useState<OpencodeClient | null>(null);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [installFolder, setInstallFolder] = useState<string | null>(null);

  const sseAbortRef = useRef<AbortController | null>(null);

  // Get port from Electron, wait for the server, then create the client.
  useEffect(() => {
    if (ready) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    const unsubscribeProgress = desktop.onOpenCodeStartupProgress((progress) => {
      if (!cancelled) setEngineProgress(progress);
    });

    // The desktop service owns startup, its deadline, and process cleanup.
    async function getServerInfo() {
      return desktop.getOpenCodeInfo();
    }

    // Step 2: Poll the HTTP server until it responds.
    async function waitForServer(baseUrl: string, authorization: string): Promise<void> {
      const deadline = Date.now() + SERVER_WAIT_MS;
      while (!cancelled) {
        if (Date.now() > deadline) {
          throw new Error(
            `OpenCode did not become healthy within ${SERVER_WAIT_MS / 1000} seconds after it started`,
          );
        }
        try {
          const res = await fetch(`${baseUrl}/session`, {
            headers: { Authorization: authorization },
            method: "GET",
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok || res.status >= 400) return;
        } catch {
          // Connection refused or timeout - keep polling.
        }
        await new Promise((r) => {
          retryTimer = setTimeout(r, 1000);
        });
      }
      throw new Error("cancelled");
    }

    async function init() {
      try {
        setStatus("waiting");
        setInitError(null);
        setStartupPhase("engine");
        setEngineProgress(DEFAULT_ENGINE_PROGRESS);
        const { port: ocPort, workspace, authorization } = await getServerInfo();
        if (cancelled) return;

        setStartupPhase("connection");
        const baseUrl = `http://127.0.0.1:${ocPort}`;
        await waitForServer(baseUrl, authorization);
        if (cancelled) return;

        const newClient = createOpencodeClient({
          baseUrl,
          directory: workspace,
          headers: { Authorization: authorization },
        });
        setStartupPhase("workspace");
        await prefetchServerState(newClient, queryClient);
        if (cancelled) return;

        setPort(ocPort);
        setClient(newClient);
        setReady(true);
        setStatus("ready");
        setInitError(null);
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to initialize OpenCode:", err);
        setStatus("error");
        setInitError(String(err));
      }
    }

    init();

    return () => {
      cancelled = true;
      unsubscribeProgress();
      clearTimeout(retryTimer);
    };
  }, [ready, queryClient]);

  // AI traces read session history from the local server.
  useEffect(() => {
    if (!client) return;
    aiTracer.configure({
      loadHistory: async (sessionID) =>
        (await client.session.messages({ sessionID }, { throwOnError: true })).data,
      loadInstructions: () => desktop.getInstructionFiles(),
    });
    return () => aiTracer.configure({});
  }, [client]);

  // ── SSE subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !ready) return;

    const abortController = new AbortController();
    sseAbortRef.current = abortController;
    let consecutiveFailures = 0;
    let reconnectToastId: string | number | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function showReconnectToast() {
      if (reconnectToastId != null) return;
      reconnectToastId = notify.error("Lost connection to BloxBot's engine", {
        name: "connection_lost",
        description: "Replies won't update until it's back.",
        duration: Number.POSITIVE_INFINITY,
        system: true,
        action: {
          label: "Reconnect",
          onClick: () => window.location.reload(),
        },
      });
    }

    function dismissReconnectToast() {
      if (reconnectToastId != null) {
        notify.dismiss(reconnectToastId);
        reconnectToastId = undefined;
      }
    }

    function scheduleReconnect() {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (!abortController.signal.aborted) void subscribe();
      }, SSE_RECONNECT_DELAY);
    }

    async function subscribe() {
      try {
        if (!client) return;
        const sseResult = await client.event.subscribe({}, { throwOnError: true });
        if (!sseResult?.stream) {
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          if (!abortController.signal.aborted) scheduleReconnect();
          return;
        }
        await reconcileServerState(queryClient, activeSessionIdRef.current);
        sessionNotifier.trackRunning(queryClient.getQueryData(qk.statuses));
        consecutiveFailures = 0;
        dismissReconnectToast();

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          sseDispatch(queryClient, event, activeSessionIdRef, (usage) => {
            captureDetailedAnalytics(posthog, "model_usage", usage);
          });
          try {
            sessionNotifier.handleEvent(queryClient, event, activeSessionIdRef);
          } catch (error) {
            console.warn("Session notification failed:", error);
          }
          try {
            aiTracer.handleEvent(event);
          } catch (error) {
            console.warn("AI trace capture failed:", error);
          }
        }

        if (!abortController.signal.aborted) {
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          scheduleReconnect();
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.error("SSE stream error:", err);
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          scheduleReconnect();
        }
      }
    }

    subscribe();

    return () => {
      abortController.abort();
      clearTimeout(reconnectTimer);
      sseAbortRef.current = null;
      dismissReconnectToast();
    };
  }, [client, ready, queryClient, activeSessionIdRef]);

  // Shown on screen only, so antivirus exclusions can target it. Never sent to analytics.
  useEffect(() => {
    if (!initError) return;
    let cancelled = false;
    desktop
      .getOpenCodeInstallFolder()
      .then((folder) => {
        if (!cancelled) setInstallFolder(folder);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [initError]);

  // Any news restarts the clock, so this only shows once a step has actually gone quiet.
  const [slow, setSlow] = useState(false);
  const [verySlow, setVerySlow] = useState(false);
  // A retry of a download isn't news. Only data arriving means it isn't stuck.
  const startupNews =
    engineProgress.phase === "downloading"
      ? `downloading:${engineProgress.downloadedBytes}`
      : engineProgress.phase;
  // biome-ignore lint/correctness/useExhaustiveDependencies: watches for startup news, not its contents
  useEffect(() => {
    setSlow(false);
    setVerySlow(false);
    if (ready || initError) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_STEP_MS);
    const later = window.setTimeout(
      () => setVerySlow(true),
      startupPhase === "engine" && engineProgress.phase === "starting"
        ? TRY_AGAIN_WHILE_STARTING_MS
        : TRY_AGAIN_AFTER_MS,
    );
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(later);
    };
  }, [startupPhase, startupNews, ready, initError]);

  // Stays once it's there: data arriving shouldn't pull it out from under someone's focus.
  const [retryOffered, setRetryOffered] = useState(false);
  const retryWorthOffering = engineProgress.phase === "downloading" ? slow : verySlow;
  useEffect(() => {
    if (retryWorthOffering) setRetryOffered(true);
  }, [retryWorthOffering]);

  const value = useMemo<OpenCodeClientContextValue>(
    () => ({ client, status, port, ready, initError }),
    [client, status, port, ready, initError],
  );

  if (!ready) {
    const startup = getStartupPresentation(startupPhase, engineProgress, slow);
    const startupError = initError ? getStartupErrorPresentation(initError, installFolder) : null;
    return (
      <OpenCodeClientContext.Provider value={value}>
        <LoadingScreen
          message={startupError?.message ?? startup.message}
          detail={startupError?.detail ?? startup.detail}
          detailPath={startupError?.detailPath}
          helpLink={startupError?.helpLink}
          technicalDetail={startupError?.technicalDetail}
          startup={startupError ? undefined : startup.startup}
          error={!!startupError}
          onRetry={startupError || retryOffered ? () => desktop.relaunch() : undefined}
        />
      </OpenCodeClientContext.Provider>
    );
  }

  return <OpenCodeClientContext.Provider value={value}>{children}</OpenCodeClientContext.Provider>;
}

// ── Pre-warm query cache with server state ──
// Hooks have their own queryFn as fallback, but seeding the cache here
// avoids extra round-trips on first render.

export async function prefetchServerState(client: OpencodeClient, queryClient: QueryClient) {
  const results = await Promise.allSettled([
    client.experimental.session.list({ archived: true }, { throwOnError: true }),
    client.provider.list({}, { throwOnError: true }),
    client.session.status({}, { throwOnError: true }),
    client.provider.auth({}, { throwOnError: true }),
  ]);
  if (results.every((result) => result.status === "rejected")) {
    throw new Error("OpenCode server state is unavailable");
  }
  const [sessionResult, providerResult, statusResult, authResult] = results;
  const sessionRes = sessionResult.status === "fulfilled" ? sessionResult.value : undefined;
  const providerRes = providerResult.status === "fulfilled" ? providerResult.value : undefined;
  const statusRes = statusResult.status === "fulfilled" ? statusResult.value : undefined;
  const authRes = authResult.status === "fulfilled" ? authResult.value : undefined;

  if (sessionRes?.data) {
    const sorted = [...sessionRes.data].sort((a, b) => b.time.created - a.time.created);
    queryClient.setQueryData(qk.sessions, sorted);
  }

  if (statusRes?.data) {
    queryClient.setQueryData(qk.statuses, statusRes.data);
  }

  if (providerRes?.data) {
    const providerData = authRes?.data
      ? { ...providerRes.data, authMethods: authRes.data }
      : providerRes.data;
    queryClient.setQueryData(qk.providers, providerData);
  }
}

export async function reconcileServerState(
  queryClient: QueryClient,
  activeSessionId: string | null,
) {
  const queryKeys: readonly (readonly unknown[])[] = [
    qk.sessions,
    qk.statuses,
    qk.providers,
    ...(activeSessionId
      ? [
          qk.messages(activeSessionId),
          qk.todos(activeSessionId),
          qk.questions(activeSessionId),
          qk.permissions(activeSessionId),
        ]
      : []),
  ];

  await Promise.all(
    queryKeys.map((queryKey) =>
      queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "active" }),
    ),
  );
}
