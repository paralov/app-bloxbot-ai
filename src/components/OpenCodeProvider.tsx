import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

import { useStore } from "@/stores/opencode";
import type { OpenCodeStatus } from "@/types";

const SSE_RECONNECT_DELAY = 3000;
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
      console.debug("frontend", `Creating SDK client for port ${port}`);
      invoke<string>("get_workspace_dir")
        .then((dir) => {
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
          console.debug("frontend", `Failed to get workspace dir: ${err}`);
          console.error("Failed to get workspace directory:", err);
        });
    } else if (status !== "Running" && client) {
      console.debug("frontend", "Server no longer running, clearing client");
      useStore.getState().setClient(null);
    }
  }, [status, port, client]);

  // ── Init trigger: when client becomes available, run init with retry ─
  useEffect(() => {
    if (client && !ready) {
      console.debug("frontend", "Client available, running init()");
      useStore
        .getState()
        .init()
        .then(() => {
          console.debug("frontend", "init() completed");
        })
        .catch((err) => {
          console.debug("frontend", `init() failed: ${err}`);
        });
    }
  }, [client, ready]);

  // ── SSE subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!client || !ready) return;

    const abortController = new AbortController();
    sseAbortRef.current = abortController;

    async function subscribe() {
      try {
        const c = useStore.getState().client;
        if (!c) return;

        console.debug("frontend", "Subscribing to SSE events");
        const sseResult = await c.event.subscribe({});
        if (!sseResult?.stream) {
          console.debug("frontend", "SSE subscribe returned no stream");
          return;
        }
        console.debug("frontend", "SSE stream connected");

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          useStore.getState().handleEvent(event);
        }
        console.debug("frontend", "SSE stream ended");
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.debug("frontend", `SSE stream error: ${err}`);
          console.error("SSE stream error:", err);
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
    };
  }, [client, ready]);

  // ── Studio plugin status polling ──────────────────────────────────────
  useEffect(() => {
    if (!client || !ready) return;
    useStore.getState().pollStudioStatus();
    const interval = setInterval(() => {
      useStore.getState().pollStudioStatus();
    }, STUDIO_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [client, ready]);

  // ── Disconnect / reconnect toasts ───────────────────────────────────
  useEffect(() => {
    const label = serverStatusLabel(status);
    const prev = prevServerLabel.current;
    prevServerLabel.current = label;

    if (prev === "running" && label !== "running") {
      toast.error("Disconnected from OpenCode", {
        description: "The server stopped unexpectedly. It will restart automatically.",
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
