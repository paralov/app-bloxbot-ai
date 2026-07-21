import type { Session } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useRenameSession() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionID, title }: { sessionID: string; title: string }) => {
      if (!client) throw new Error("No client");
      const res = await client.session.update({ sessionID, title }, { throwOnError: true });
      if (!res.data) throw new Error("No data");
      return res.data;
    },
    onSuccess: (updated: Session) => {
      queryClient.setQueryData<Session[]>(qk.sessions, (prev) => {
        if (!prev) return prev;
        return prev.map((s) => (s.id === updated.id ? updated : s));
      });
    },
  });
}
