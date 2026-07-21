import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useSessionStatuses() {
  const { client, ready } = useOpenCodeClient();

  return useQuery<Record<string, SessionStatus>>({
    queryKey: qk.statuses,
    queryFn: async () => {
      if (!client) return {};
      const res = await client.session.status({}, { throwOnError: true });
      return res.data ?? {};
    },
    enabled: ready && !!client,
  });
}

export function useIsBusy(sessionId: string | null): boolean {
  const status = useSessionStatus(sessionId);
  return status !== undefined && status.type !== "idle";
}

export function useSessionStatus(sessionId: string | null): SessionStatus | undefined {
  const { client, ready } = useOpenCodeClient();

  return useQuery<Record<string, SessionStatus>, Error, SessionStatus | undefined>({
    queryKey: qk.statuses,
    queryFn: async () => {
      if (!client) return {};
      const res = await client.session.status({}, { throwOnError: true });
      return res.data ?? {};
    },
    enabled: ready && !!client,
    select: useCallback(
      (statuses: Record<string, SessionStatus>) => (sessionId ? statuses[sessionId] : undefined),
      [sessionId],
    ),
  }).data;
}
