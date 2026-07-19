import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import LoadingScreen, { type LoadingStep } from "@/components/LoadingScreen";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { sseDispatch } from "@/lib/sseDispatch";

const SSE_RECONNECT_DELAY = 3000;
const SSE_FAILURE_THRESHOLD = 3;

type AppStatus = "waiting" | "ready" | "error";
export type StartupPhase = "engine" | "connection" | "workspace";

const STARTUP_STEPS = [
  {
    id: "engine",
    title: "Prepare OpenCode",
    description: "Verify the runtime and start the private local service.",
  },
  {
    id: "connection",
    title: "Confirm local connection",
    description: "Wait for the engine to become healthy on this device.",
  },
  {
    id: "workspace",
    title: "Restore workspace",
    description: "Load sessions, providers, models, agents, and status.",
  },
] as const;

const STARTUP_COPY: Record<StartupPhase, { message: string; detail: string }> = {
  engine: {
    message: "Preparing the AI engine",
    detail:
      "Checking for a verified OpenCode runtime and starting it securely. The first launch may take a little longer.",
  },
  connection: {
    message: "Connecting to the AI engine",
    detail: "OpenCode is running. BloxBot is confirming the private local connection.",
  },
  workspace: {
    message: "Loading your workspace",
    detail: "Restoring the data BloxBot needs before opening your chat.",
  },
};

export function getStartupPresentation(phase: StartupPhase): {
  message: string;
  detail: string;
  steps: LoadingStep[];
} {
  const activeIndex = STARTUP_STEPS.findIndex((step) => step.id === phase);
  return {
    ...STARTUP_COPY[phase],
    steps: STARTUP_STEPS.map((step, index) => ({
      ...step,
      status: index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending",
    })),
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

    async function subscribe() {
      try {
        if (!client) return;
        const sseResult = await client.event.subscribe({});
        if (!sseResult?.stream) {
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          if (!abortController.signal.aborted) {
            setTimeout(() => {
              if (!abortController.signal.aborted) subscribe();
            }, SSE_RECONNECT_DELAY);
          }
          return;
        }
        consecutiveFailures = 0;
        dismissReconnectToast();

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          sseDispatch(queryClient, event, activeSessionIdRef);
        }

        if (!abortController.signal.aborted) {
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          setTimeout(() => {
            if (!abortController.signal.aborted) subscribe();
          }, SSE_RECONNECT_DELAY);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.error("SSE stream error:", err);
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) showReconnectToast();
          setTimeout(() => {
            if (!abortController.signal.aborted) subscribe();
          }, SSE_RECONNECT_DELAY);
        }
      }
    }

    subscribe();

    return () => {
      abortController.abort();
      sseAbortRef.current = null;
      dismissReconnectToast();
    };
  }, [client, ready, queryClient, activeSessionIdRef]);

  const value: OpenCodeClientContextValue = {
    client,
    status,
    port,
    ready,
    initError,
  };

  if (!ready) {
    const startup = getStartupPresentation(startupPhase);
    return (
      <OpenCodeClientContext.Provider value={value}>
        <LoadingScreen
          message={initError ? "Failed to connect to OpenCode" : startup.message}
          detail={initError ?? startup.detail}
          steps={initError ? undefined : startup.steps}
          note="OpenCode starts as a private service that only listens on this device."
          error={!!initError}
          onRetry={initError ? () => desktop.relaunch() : undefined}
        />
      </OpenCodeClientContext.Provider>
    );
  }

  return <OpenCodeClientContext.Provider value={value}>{children}</OpenCodeClientContext.Provider>;
}

// ── Pre-warm query cache with server state ──
// Hooks have their own queryFn as fallback, but seeding the cache here
// avoids extra round-trips on first render.

async function prefetchServerState(client: OpencodeClient, queryClient: QueryClient) {
  const [sessionRes, providerRes, statusRes, agentsRes, authRes] = await Promise.all([
    client.session.list({}),
    client.provider.list({}),
    client.session.status({}),
    client.app.agents({}).catch(() => ({ data: undefined })),
    client.provider.auth({}).catch(() => ({ data: undefined })),
  ]);

  if (sessionRes.data) {
    const sorted = [...sessionRes.data].sort((a, b) => b.time.created - a.time.created);
    queryClient.setQueryData(qk.sessions, sorted);
  }

  if (statusRes.data) {
    queryClient.setQueryData(qk.statuses, statusRes.data);
  }

  if (agentsRes.data && Array.isArray(agentsRes.data)) {
    queryClient.setQueryData(qk.agents, agentsRes.data);
  }

  if (providerRes.data) {
    const providerData = authRes.data
      ? { ...providerRes.data, authMethods: authRes.data }
      : providerRes.data;
    queryClient.setQueryData(qk.providers, providerData);
  }
}
