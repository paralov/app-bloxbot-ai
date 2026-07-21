import type { QuestionRequest } from "@opencode-ai/sdk/v2/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const NOOP_KEY = ["__noop-question__"] as const;

export function useActiveQuestion(): QuestionRequest | null {
  const { activeSessionId } = useActiveSession();
  const { client, ready } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { data } = useQuery<QuestionRequest | null>({
    queryKey: activeSessionId ? qk.questions(activeSessionId) : NOOP_KEY,
    queryFn: async () => {
      if (!client || !activeSessionId) return null;
      const queryKey = qk.questions(activeSessionId);
      const beforeRevision =
        queryClient.getQueryState<QuestionRequest | null>(queryKey)?.dataUpdateCount ?? 0;
      const response = await client.question.list({}, { throwOnError: true });
      const afterState = queryClient.getQueryState<QuestionRequest | null>(queryKey);
      if ((afterState?.dataUpdateCount ?? 0) !== beforeRevision) return afterState?.data ?? null;
      return response.data?.find((question) => question.sessionID === activeSessionId) ?? null;
    },
    enabled: ready && !!client && !!activeSessionId,
  });
  return data ?? null;
}
