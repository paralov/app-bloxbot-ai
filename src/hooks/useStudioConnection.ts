import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { desktop } from "@/lib/desktop";
import type { OpencodeClient } from "@/lib/opencode/client";
import { qk } from "@/lib/queryKeys";
import { STUDIO_MCP_SERVER_NAME } from "@/lib/studioMcp";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import type { StudioMcpStatus } from "@/types/desktop";

const STUDIO_MCP_NAME = STUDIO_MCP_SERVER_NAME;
const CONNECT_WAIT_MS = 10_000;

export type StudioConnectionState = "checking" | "connected" | "waiting";

/** Why Studio's MCP helper can't be reached, when BloxBot knows. */
export type StudioMcpProblem = Extract<
  StudioMcpStatus["state"],
  "not_installed" | "helper_missing" | "unavailable"
>;

export function studioMcpProblem(status: StudioMcpStatus | undefined): StudioMcpProblem | null {
  return status?.state === "not_installed" ||
    status?.state === "helper_missing" ||
    status?.state === "unavailable"
    ? status.state
    : null;
}

async function attemptStudioConnection(
  client: Pick<OpencodeClient, "mcp">,
): Promise<Exclude<StudioConnectionState, "checking">> {
  try {
    const current = await client.mcp.status({});
    if (current.data?.[STUDIO_MCP_NAME]?.status === "connected") return "connected";

    await client.mcp.connect({ name: STUDIO_MCP_NAME }).catch(() => undefined);
    const refreshed = await client.mcp.status({});
    return refreshed.data?.[STUDIO_MCP_NAME]?.status === "connected" ? "connected" : "waiting";
  } catch {
    return "waiting";
  }
}

// Giving up on a check doesn't stop its requests, so a hung one is waited on again rather than
// joined by another every few seconds.
const attempts = new WeakMap<object, Promise<Exclude<StudioConnectionState, "checking">>>();

/** Any of it can hang, and the app waits on this to get past "Finding Roblox Studio". */
export function checkStudioConnection(
  client: Pick<OpencodeClient, "mcp">,
): Promise<Exclude<StudioConnectionState, "checking">> {
  let attempt = attempts.get(client);
  if (!attempt) {
    attempt = attemptStudioConnection(client).finally(() => attempts.delete(client));
    attempts.set(client, attempt);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    attempt,
    new Promise<"waiting">((resolve) => {
      timer = setTimeout(() => resolve("waiting"), CONNECT_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function useStudioConnection() {
  const { client } = useOpenCodeClient();

  const query = useQuery<Exclude<StudioConnectionState, "checking">>({
    queryKey: qk.studioConnection,
    queryFn: async () => {
      if (!client) return "waiting";
      return checkStudioConnection(client);
    },
    enabled: !!client,
    refetchInterval: (queryState) => (queryState.state.data === "connected" ? 10_000 : 3_000),
    retry: false,
  });

  const waiting = query.data === "waiting";
  const studioMcp = useQuery({
    queryKey: qk.studioMcpStatus,
    queryFn: () => desktop.getStudioMcpStatus(),
    enabled: !!client && waiting,
    refetchInterval: 3_000,
    retry: false,
  });

  // The background checks every few seconds aren't news to anyone, and shouldn't move their focus.
  const [checking, setChecking] = useState(false);
  const checkAgain = async () => {
    setChecking(true);
    try {
      await query.refetch();
    } finally {
      setChecking(false);
    }
  };

  return {
    state: query.isPending ? ("checking" as const) : (query.data ?? "waiting"),
    checking,
    checkAgain,
    problem: waiting ? studioMcpProblem(studioMcp.data) : null,
  };
}
