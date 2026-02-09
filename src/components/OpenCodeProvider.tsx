import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useStore } from "@/stores/opencode";
import type { OpenCodeStatus } from "@/types";

const SSE_RECONNECT_DELAY = 3000;
const STUDIO_POLL_INTERVAL = 2000;

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
    // Fetch initial status (in case events were emitted before frontend loaded)
    useStore.getState().fetchInitialStatus();

    const unlisten = listen<StatusPayload>("opencode-status-changed", (event) => {
      useStore.getState().setServerStatus(event.payload.status, event.payload.port);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // ── Client creation: when server becomes "Running", create SDK client ─
  useEffect(() => {
    if (status === "Running" && !client) {
      invoke<string>("get_workspace_dir")
        .then((dir) => {
          useStore.getState().setClient(
            createOpencodeClient({
              baseUrl: `http://127.0.0.1:${port}`,
              directory: dir,
            }),
          );
        })
        .catch((err) => {
          console.error("Failed to get workspace directory:", err);
        });
    } else if (status !== "Running" && client) {
      useStore.getState().setClient(null);
    }
  }, [status, port, client]);

  // ── Init trigger: when client becomes available, run init with retry ─
  useEffect(() => {
    if (client && !ready) {
      useStore.getState().init();
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

        const sseResult = await c.event.subscribe({});
        if (!sseResult?.stream) return;

        for await (const event of sseResult.stream) {
          if (abortController.signal.aborted) break;
          useStore.getState().handleEvent(event);
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
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
