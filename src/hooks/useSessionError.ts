import { useQuery } from "@tanstack/react-query";

import type { ModelError } from "@/lib/modelError";
import { qk } from "@/lib/queryKeys";
import { useActiveSession } from "@/providers/ActiveSessionProvider";

const NOOP_KEY = ["__noop-session-error__"] as const;

export function useSessionError(): ModelError | null {
  const { activeSessionId } = useActiveSession();
  const { data } = useQuery<ModelError | null>({
    queryKey: activeSessionId ? qk.sessionError(activeSessionId) : NOOP_KEY,
    queryFn: async () => null,
    enabled: false,
  });
  return data ?? null;
}
