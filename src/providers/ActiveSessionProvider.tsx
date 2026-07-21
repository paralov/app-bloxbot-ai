import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { qk } from "@/lib/queryKeys";

interface ActiveSessionContextValue {
  activeSessionId: string | null;
  selectSession: (sessionID: string) => Promise<void>;
  clearSession: () => void;
  /** Ref that always holds the current activeSessionId  - used by SSE dispatch */
  activeSessionIdRef: React.RefObject<string | null>;
}

export const ActiveSessionContext = createContext<ActiveSessionContextValue>({
  activeSessionId: null,
  selectSession: async () => {},
  clearSession: () => {},
  activeSessionIdRef: { current: null },
});

export function useActiveSession() {
  return useContext(ActiveSessionContext);
}

export function ActiveSessionProvider({
  children,
  activeSessionIdRef,
}: {
  children: ReactNode;
  activeSessionIdRef: React.MutableRefObject<string | null>;
}) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const selectSession = useCallback(
    async (sessionID: string) => {
      activeSessionIdRef.current = sessionID;
      setActiveSessionId(sessionID);
      queryClient.setQueryData(qk.sessionError(sessionID), null);

      // Mark every session-owned snapshot stale. The newly mounted observers fetch
      // them once, while switching remains immediate and cannot race an older click.
      await Promise.all(
        [
          qk.messages(sessionID),
          qk.todos(sessionID),
          qk.questions(sessionID),
          qk.permissions(sessionID),
        ].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" }),
        ),
      );
    },
    [queryClient, activeSessionIdRef],
  );

  const clearSession = useCallback(() => {
    activeSessionIdRef.current = null;
    setActiveSessionId(null);
  }, [activeSessionIdRef]);

  const value = useMemo<ActiveSessionContextValue>(
    () => ({ activeSessionId, selectSession, clearSession, activeSessionIdRef }),
    [activeSessionId, selectSession, clearSession, activeSessionIdRef],
  );

  return <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>;
}
