import type { Session } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

type ArchiveSessionInput = {
  sessionID: string;
  archived: boolean;
};

export function useArchiveSession() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { activeSessionId, clearSession, selectSession } = useActiveSession();

  return useMutation({
    mutationFn: async ({ sessionID, archived }: ArchiveSessionInput) => {
      if (!client) throw new Error("No client");
      const response = await client.session.update(
        { sessionID, time: archived ? { archived: Date.now() } : {} },
        { throwOnError: true },
      );
      if (!response.data) throw new Error("OpenCode did not update the session");
      return { session: response.data, archived };
    },
    onSuccess: ({ session, archived }) => {
      queryClient.setQueryData<Session[]>(qk.sessions, (previous) => {
        if (!previous) return [session];
        return previous.map((item) => (item.id === session.id ? session : item));
      });

      if (archived && activeSessionId === session.id) {
        clearSession();
      } else if (!archived) {
        void selectSession(session.id);
      }
    },
  });
}
