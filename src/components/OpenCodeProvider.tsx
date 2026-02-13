import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useStore } from "@/stores/opencode";
import type { OpenCodeStatus } from "@/types";

const SSE_RECONNECT_DELAY = 3000;
/** After this many consecutive SSE failures, show a reconnect toast. */
const SSE_FAILURE_THRESHOLD = 3;
const STUDIO_POLL_INTERVAL = 500;

interface StatusPayload {
  status: OpenCodeStatus;
  port: number;
}

function serverStatusLabel(status: OpenCodeStatus): "starting" | "running" | "stopped" | "error" {
  if (status === "Running") return "running";
  if (status === "Starting") return "starting";
  if (typeof status === "object" && "Error" in status) return "error";
  return "stopped";
}

interface OpenCodeProviderProps {
  children: ReactNode;
}

function OpenCodeProvider({ children }: OpenCodeProviderProps) {
  const prevServerLabel = useRef<string>("stopped");
  /** Track whether the server has been usably running (SDK ready). */
  const hasBeenReady = useRef(false);
  const sseAbortRef = useRef<AbortController | null>(null);

  // Subscribe to store slices needed for side effects
  const status = useStore((s) => s.status);
  const port = useStore((s) => s.port);
  const client = useStore((s) => s.client);
  const ready = useStore((s) => s.ready);

  // ── Tauri event listener for status changes from the backend ─────────
  useEffect(() => {
    console.debug("frontend", "OpenCodeProvider mounted, fetching initial status");
    // Fetch initial status (in case events were emitted before frontend loaded)
    useStore.getState().fetchInitialStatus();

    const unlisten = listen<StatusPayload>("opencode-status-changed", (event) => {
      const s = event.payload.status;
      const label = typeof s === "object" && "Error" in s ? `Error(${s.Error})` : String(s);
      console.debug("frontend", `Server status changed: ${label} (port ${event.payload.port})`);
      useStore.getState().setServerStatus(event.payload.status, event.payload.port);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── Client creation: when server becomes "Running", create SDK client ─
  useEffect(() => {
    if (status === "Running" && !client) {
      let cancelled = false;
      let retryTimer: ReturnType<typeof setTimeout>;

      const attempt = () => {
        console.debug("frontend", `Creating SDK client for port ${port}`);
        invoke<string>("get_workspace_dir")
          .then((dir) => {
            if (cancelled) return;
            console.debug("frontend", `Workspace dir: ${dir}`);
            useStore.getState().setClient(
              createOpencodeClient({
                baseUrl: `http://127.0.0.1:${port}`,
                directory: dir,
              }),
            );
            console.debug("frontend", "SDK client created");
          })
          .catch((err) => {
            if (cancelled) return;
            console.error("Failed to get workspace directory:", err);
            retryTimer = setTimeout(attempt, 2000);
          });
      };
      attempt();

      return () => {
        cancelled = true;
        clearTimeout(retryTimer);
      };
    } else if (status !== "Running" && client) {
      console.debug("frontend", "Server no longer running, clearing client");
      useStore.getState().setClient(null);
    }
  }, [status, port, client]);

  // ── Init trigger: when client becomes available, run init with retry ─
  useEffect(() => {
    if (!client || ready) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const attempt = () => {
      console.debug("frontend", "Client available, running init()");
      useStore
        .getState()
        .init()
        .then(() => {
          console.debug("frontend", "init() completed");
        })
        .catch((err) => {
          if (cancelled) return;
          console.debug("frontend", `init() failed: ${err}, retrying in 3s`);
          retryTimer = setTimeout(attempt, 3000);
        });
    };
    attempt();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [client, ready]);

  // ── SSE subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !ready) return;

    const abortController = new AbortController();
    sseAbortRef.current = abortController;
    let consecutiveFailures = 0;
    /** ID of the persistent reconnect toast so we can dismiss it. */
    let reconnectToastId: string | number | undefined;

    function showReconnectToast() {
      // Only show once — avoid stacking toasts
      if (reconnectToastId != null) return;
      reconnectToastId = toast.error("Lost connection to OpenCode", {
        description: "Events are no longer being received.",
        duration: Infinity,
        action: {
          label: "Reconnect",
          onClick: () => {
            // Tear down the SDK client. This triggers the client-creation
            // effect which rebuilds the client → init → SSE resubscription.
            console.debug("frontend", "User triggered reconnect");
            useStore.getState().setClient(null);
          },
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
        const c = useStore.getState().client;
        if (!c) return;

        console.debug("frontend", "Subscribing to SSE events");
        const sseResult = await c.event.subscribe({});
        if (!sseResult?.stream) {
          console.debug("frontend", "SSE subscribe returned no stream");
          // Treat as a failure — the server didn't give us a stream
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) {
            showReconnectToast();
          }
          if (!abortController.signal.aborted) {
            setTimeout(() => {
              if (!abortController.signal.aborted) subscribe();
            }, SSE_RECONNECT_DELAY);
          }
          return;
        }
        console.debug("frontend", "SSE stream connected");
        // Successfully connected — reset failure counter and dismiss any toast
        consecutiveFailures = 0;
        dismissReconnectToast();

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          useStore.getState().handleEvent(event);
        }
        console.debug("frontend", "SSE stream ended");

        // Stream ended cleanly (not aborted by us). This typically means the
        // OpenCode server closed the connection. Retry automatically.
        if (!abortController.signal.aborted) {
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) {
            showReconnectToast();
          }
          setTimeout(() => {
            if (!abortController.signal.aborted) subscribe();
          }, SSE_RECONNECT_DELAY);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.debug("frontend", `SSE stream error: ${err}`);
          console.error("SSE stream error:", err);
          consecutiveFailures++;
          if (consecutiveFailures >= SSE_FAILURE_THRESHOLD) {
            showReconnectToast();
          }
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
  }, [client, ready]);

  // ── Studio plugin status polling ──────────────────────────────────────
  // Uses the OpenCode SDK (c.mcp.status) as the primary source, falling
  // back to the HTTP health endpoint for plugin connection status.
  // pollStudioStatus gracefully handles the case where the SDK client
  // isn't ready yet (falls through to the health endpoint).
  useEffect(() => {
    if (status !== "Running") return;
    useStore.getState().pollStudioStatus();
    const interval = setInterval(() => {
      useStore.getState().pollStudioStatus();
    }, STUDIO_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [status]);

  // ── Track whether the app has been fully usable ────────────────────
  useEffect(() => {
    if (ready) {
      hasBeenReady.current = true;
    }
  }, [ready]);

  // ── Disconnect / reconnect toasts ───────────────────────────────────
  useEffect(() => {
    const label = serverStatusLabel(status);
    const prev = prevServerLabel.current;
    prevServerLabel.current = label;

    // Only show the disconnect toast if the server was previously usable
    // (SDK was initialized). Startup failures are shown by the
    // LoadingScreen error state — no need for a redundant toast.
    if (prev === "running" && label !== "running" && hasBeenReady.current) {
      toast.error("Disconnected from OpenCode", {
        description: "The server stopped unexpectedly.",
        duration: Infinity,
      });
    }

    if (prev !== "running" && label === "running") {
      toast.dismiss();
    }
  }, [status]);

  return <>{children}</>;
}

export default OpenCodeProvider;
