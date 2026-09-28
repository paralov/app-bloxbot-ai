import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { useQuery } from "@tanstack/react-query";

import { STUDIO_MCP_SERVER_NAME } from "@/lib/bloxbotProgramManifest";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
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

  return {
    state: query.isPending ? ("checking" as const) : (query.data ?? "waiting"),
    checking: query.isFetching,
    checkAgain: query.refetch,
    problem: waiting ? studioMcpProblem(studioMcp.data) : null,
  };
}
