import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
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
import { toast } from "sonner";
import LoadingScreen, { type StartupProgress } from "@/components/LoadingScreen";
import { captureDetailedAnalytics } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
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
  message: string;
  detail: string;
  technicalDetail: string;
}

const DEFAULT_ENGINE_PROGRESS: OpenCodeStartupProgress = { phase: "checking" };

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
        meta: [percentage, formatTransferSpeed(progress.bytesPerSecond)]
          .filter(Boolean)
          .join(" · "),
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

export function getStartupPresentation(
  phase: StartupPhase,
  engineProgress: OpenCodeStartupProgress = DEFAULT_ENGINE_PROGRESS,
): StartupPresentation {
  return phase === "engine" ? getEnginePresentation(engineProgress) : STARTUP_COPY[phase];
}

export function getStartupErrorPresentation(error: unknown): StartupErrorPresentation {
  const technicalDetail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const normalized = technicalDetail.toLowerCase();

  if (
    normalized.includes("github release lookup") ||
    normalized.includes("opencode download") ||
    normalized.includes("verified opencode")
  ) {
    return {
      message: "Setup couldn't finish",
      detail:
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then restart setup.",
      technicalDetail,
    };
  }

  if (normalized.includes("does not provide a supported binary")) {
    return {
      message: "This computer isn't supported yet",
      detail:
        "BloxBot couldn't find a compatible setup package for this system. Check for an app update or contact support.",
      technicalDetail,
    };
  }

  return {
    message: "Setup couldn't finish",
    detail:
      "BloxBot hit a problem while preparing its local engine. Restart setup, or check for an app update if it happens again.",
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
      while (!cancelled) {
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
      reconnectToastId = toast.error("Lost connection to OpenCode", {
        description: "Events are no longer being received.",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Reconnect",
          onClick: () => window.location.reload(),
        },
      });
    }

    function dismissReconnectToast() {
      if (reconnectToastId != null) {
        toast.dismiss(reconnectToastId);
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
        consecutiveFailures = 0;
        dismissReconnectToast();

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          sseDispatch(queryClient, event, activeSessionIdRef, (usage) => {
            captureDetailedAnalytics(posthog, "model_usage", usage);
          });
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

  const value = useMemo<OpenCodeClientContextValue>(
    () => ({ client, status, port, ready, initError }),
    [client, status, port, ready, initError],
  );

  if (!ready) {
    const startup = getStartupPresentation(startupPhase, engineProgress);
    const startupError = initError ? getStartupErrorPresentation(initError) : null;
    return (
      <OpenCodeClientContext.Provider value={value}>
        <LoadingScreen
          message={startupError?.message ?? startup.message}
          detail={startupError?.detail ?? startup.detail}
          technicalDetail={startupError?.technicalDetail}
          startup={startupError ? undefined : startup.startup}
          error={!!startupError}
          onRetry={startupError ? () => desktop.relaunch() : undefined}
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
    client.session.list({}, { throwOnError: true }),
    client.provider.list({}, { throwOnError: true }),
    client.session.status({}, { throwOnError: true }),
    client.app.agents({}, { throwOnError: true }),
    client.provider.auth({}, { throwOnError: true }),
  ]);
  if (results.every((result) => result.status === "rejected")) {
    throw new Error("OpenCode server state is unavailable");
  }
  const [sessionResult, providerResult, statusResult, agentsResult, authResult] = results;
  const sessionRes = sessionResult.status === "fulfilled" ? sessionResult.value : undefined;
  const providerRes = providerResult.status === "fulfilled" ? providerResult.value : undefined;
  const statusRes = statusResult.status === "fulfilled" ? statusResult.value : undefined;
  const agentsRes = agentsResult.status === "fulfilled" ? agentsResult.value : undefined;
  const authRes = authResult.status === "fulfilled" ? authResult.value : undefined;

  if (sessionRes?.data) {
    const sorted = [...sessionRes.data].sort((a, b) => b.time.created - a.time.created);
    queryClient.setQueryData(qk.sessions, sorted);
  }

  if (statusRes?.data) {
    queryClient.setQueryData(qk.statuses, statusRes.data);
  }

  if (agentsRes?.data && Array.isArray(agentsRes.data)) {
    queryClient.setQueryData(qk.agents, agentsRes.data);
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
    qk.agents,
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
