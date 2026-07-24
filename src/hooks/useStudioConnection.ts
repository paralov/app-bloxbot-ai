import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { useQuery } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const STUDIO_MCP_NAME = "roblox-studio";

export type StudioConnectionState = "checking" | "connected" | "waiting";

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

  return {
    state: query.isPending ? ("checking" as const) : (query.data ?? "waiting"),
    checking: query.isFetching,
    checkAgain: query.refetch,
  };
}
