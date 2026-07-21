import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useAbort() {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!client || !activeSessionId) throw new Error("No client or session");
      const sessionID = activeSessionId;
      const response = await client.session.abort({ sessionID }, { throwOnError: true });
      if (response.data !== true) throw new Error("OpenCode did not acknowledge the abort");
      return sessionID;
    },
    onSuccess: (sessionID) => {
      queryClient.setQueryData<Record<string, SessionStatus>>(qk.statuses, (previous) => ({
        ...previous,
        [sessionID]: { type: "idle" },
      }));
    },
  });
}
