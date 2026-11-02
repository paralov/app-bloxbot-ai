import { useQuery } from "@tanstack/react-query";
import type { Command } from "@/lib/opencode/types";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const EMPTY: Command[] = [];

export function useCommands(): Command[] {
  const { client, ready } = useOpenCodeClient();

  const { data } = useQuery<Command[]>({
    queryKey: qk.commands,
    queryFn: async () => {
      if (!client) return [];
      const response = await client.command.list({}, { throwOnError: true });
      return Array.isArray(response.data) ? response.data : [];
    },
    enabled: ready && !!client,
  });

  return data ?? EMPTY;
}
