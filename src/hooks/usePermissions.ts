import type { PermissionRequest } from "@opencode-ai/sdk/v2/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

const NOOP_KEY = ["__noop-permission__"] as const;

export function useActivePermission(): PermissionRequest | null {
  const { activeSessionId } = useActiveSession();
  const { client, ready } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { data } = useQuery<PermissionRequest | null>({
    queryKey: activeSessionId ? qk.permissions(activeSessionId) : NOOP_KEY,
    queryFn: async () => {
      if (!client || !activeSessionId) return null;
      const queryKey = qk.permissions(activeSessionId);
      const beforeRevision =
        queryClient.getQueryState<PermissionRequest | null>(queryKey)?.dataUpdateCount ?? 0;
      const response = await client.permission.list({}, { throwOnError: true });
      const afterState = queryClient.getQueryState<PermissionRequest | null>(queryKey);
      if ((afterState?.dataUpdateCount ?? 0) !== beforeRevision) return afterState?.data ?? null;
      return response.data?.find((permission) => permission.sessionID === activeSessionId) ?? null;
    },
    enabled: ready && !!client && !!activeSessionId,
  });
  return data ?? null;
}
