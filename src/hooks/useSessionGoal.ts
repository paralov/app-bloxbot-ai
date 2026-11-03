import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SessionGoal } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const NOOP_KEY = ["__noop__"] as const;

/** The active chat's goal, kept current by the goal.changed event. */
export function useSessionGoal(): SessionGoal | null {
  const { client, ready } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const queryClient = useQueryClient();

  const { data } = useQuery<SessionGoal | null>({
    queryKey: activeSessionId ? qk.goal(activeSessionId) : NOOP_KEY,
    queryFn: async () => {
      if (!client || !activeSessionId) return null;
      const key = qk.goal(activeSessionId);
      const updatedAt = queryClient.getQueryState(key)?.dataUpdatedAt;
      // A server without the goal plugin answers with an error, and the chat shows no goal.
      const result = await client.goal
        .get({ sessionID: activeSessionId })
        .catch(() => ({ data: null }));
      // A change event that landed during the request is newer than its reply.
      const state = queryClient.getQueryState<SessionGoal | null>(key);
      if (state?.dataUpdatedAt !== updatedAt) return state?.data ?? null;
      return result.data ?? null;
    },
    enabled: ready && !!client && !!activeSessionId,
  });
  return data ?? null;
}
