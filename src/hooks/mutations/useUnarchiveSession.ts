import type { Session } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties, errorAnalyticsProperties } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useUnarchiveSession() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionID: string) => {
      if (!client) throw new Error("No client");
      const response = await client.session.update(
        { sessionID, time: { archived: 0 } },
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
      posthog.capture("session_unsnoozed", analyticsProperties("sessions", { outcome: "success" }));
    },
    onError: (error) =>
      posthog.capture(
        "session_unsnooze_failed",
        errorAnalyticsProperties("sessions", "unsnooze", error),
      ),
  });
}
