import type { Todo } from "@opencode-ai/sdk/v2/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const NOOP_KEY = ["__noop_todos__"] as const;
const EMPTY: Todo[] = [];

export function useTodos(): Todo[] {
  const { activeSessionId } = useActiveSession();
  const { client, ready } = useOpenCodeClient();
  const queryClient = useQueryClient();

  const { data } = useQuery<Todo[]>({
    queryKey: activeSessionId ? qk.todos(activeSessionId) : NOOP_KEY,
    queryFn: async () => {
      if (!client || !activeSessionId) return [];
      const queryKey = qk.todos(activeSessionId);
      const beforeRevision = queryClient.getQueryState<Todo[]>(queryKey)?.dataUpdateCount ?? 0;
      const res = await client.session.todo({ sessionID: activeSessionId }, { throwOnError: true });
      const afterState = queryClient.getQueryState<Todo[]>(queryKey);
      if ((afterState?.dataUpdateCount ?? 0) !== beforeRevision) return afterState?.data ?? [];
      return res.data ?? [];
    },
    enabled: ready && !!client && !!activeSessionId,
  });
  return data ?? EMPTY;
}
