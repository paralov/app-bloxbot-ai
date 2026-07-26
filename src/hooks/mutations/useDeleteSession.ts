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
    onSuccess: async (sessionID: string) => {
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

      const cleanup = await Promise.allSettled([
        updateStudioAssignment(queryClient, sessionID, null),
        client ? disconnectSessionStudioServer(client, sessionID) : Promise.resolve(),
      ]);
      const failure = cleanup.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        toast.error("Session deleted, but Studio cleanup failed", {
          description:
            failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        });
      }
    },
  });
}
