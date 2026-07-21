import type { PermissionRequest } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useReplyPermission() {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      requestID,
      reply,
    }: {
      requestID: string;
      reply: "once" | "always" | "reject";
    }) => {
      if (!client || !activeSessionId) throw new Error("No client or session");
      const sessionID = activeSessionId;
      await client.permission.reply({ requestID, reply }, { throwOnError: true });
      return sessionID;
    },
    onSuccess: (sessionID) => {
      queryClient.setQueryData<PermissionRequest | null>(qk.permissions(sessionID), null);
    },
  });
}
