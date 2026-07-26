import type { Session } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useArchiveSession() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { activeSessionId, clearSession } = useActiveSession();

  return useMutation({
    mutationFn: async (sessionID: string) => {
      if (!client) throw new Error("No client");
      const response = await client.session.update(
        { sessionID, time: { archived: Date.now() } },
        { throwOnError: true },
      );
      if (!response.data) throw new Error("OpenCode did not update the session");
      return response.data;
    },
    onSuccess: (session) => {
      queryClient.setQueryData<Session[]>(qk.sessions, (previous) => {
        if (!previous) return [session];
        return previous.map((item) => (item.id === session.id ? session : item));
      });

      if (activeSessionId === session.id) {
        clearSession();
      }
    },
  });
}
