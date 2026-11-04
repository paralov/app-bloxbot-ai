import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { desktop } from "@/lib/desktop";
import type { OpencodeClient } from "@/lib/opencode/client";
import { qk } from "@/lib/queryKeys";
import { STUDIO_MCP_SERVER_NAME } from "@/lib/studioMcp";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import type { StudioMcpStatus } from "@/types/desktop";

const STUDIO_MCP_NAME = STUDIO_MCP_SERVER_NAME;

export type StudioConnectionState = "checking" | "connected" | "waiting";

/** Why Studio's MCP helper can't be reached, when BloxBot knows. */
export type StudioMcpProblem = Extract<StudioMcpStatus["state"], "not_installed" | "unavailable">;

export function studioMcpProblem(status: StudioMcpStatus | undefined): StudioMcpProblem | null {
  return status?.state === "not_installed" || status?.state === "unavailable" ? status.state : null;
}

export async function checkStudioConnection(
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
