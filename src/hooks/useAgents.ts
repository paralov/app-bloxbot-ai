import type { Agent } from "@opencode-ai/sdk/v2/client";
import { useQuery } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const EMPTY: Agent[] = [];

export function useAgents(): Agent[] {
  const { client, ready } = useOpenCodeClient();

  const { data } = useQuery<Agent[]>({
    queryKey: qk.agents,
    queryFn: async () => {
      if (!client) return [];
      const res = await client.app.agents({}, { throwOnError: true });
      return Array.isArray(res.data) ? res.data : [];
    },
    enabled: ready && !!client,
  });
  return data ?? EMPTY;
}
