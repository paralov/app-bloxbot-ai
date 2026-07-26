import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { updateStudioAssignment } from "@/hooks/useStudioAssignments";
import { qk } from "@/lib/queryKeys";
import { disconnectSessionStudioServer } from "@/lib/studioRouting";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useDeleteSession() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { activeSessionId, clearSession } = useActiveSession();

  return useMutation({
    mutationFn: async (sessionID: string) => {
      if (!client) throw new Error("No client");
      const response = await client.session.delete({ sessionID }, { throwOnError: true });
      if (response.data !== true) throw new Error("OpenCode did not delete the session");
      return sessionID;
    },
    onSuccess: (sessionID: string) => {
      queryClient.setQueryData<Session[]>(qk.sessions, (prev) => {
        if (!prev) return prev;
        return prev.filter((s) => s.id !== sessionID);
      });
      queryClient.removeQueries({ queryKey: qk.session(sessionID) });
      queryClient.setQueryData<Record<string, SessionStatus>>(qk.statuses, (previous) => {
        if (!previous?.[sessionID]) return previous;
        const { [sessionID]: _deleted, ...remaining } = previous;
        return remaining;
      });

      if (activeSessionId === sessionID) {
        clearSession();
      }

      void Promise.all([
        updateStudioAssignment(queryClient, sessionID, null),
        client ? disconnectSessionStudioServer(client, sessionID) : Promise.resolve(),
      ]).catch((error) => {
        toast.error("Session deleted, but Studio cleanup failed", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
}
