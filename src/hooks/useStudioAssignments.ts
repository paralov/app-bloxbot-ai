import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { loadConfig, patchConfig } from "@/lib/config";
import { qk } from "@/lib/queryKeys";
import { type AppConfig, DEFAULT_APP_CONFIG, type StudioAssignment } from "@/types/desktop";

export async function updateStudioAssignment(
  queryClient: QueryClient,
  sessionID: string,
  assignment: StudioAssignment | null,
): Promise<void> {
  const previous =
    queryClient.getQueryData<AppConfig>(qk.config) ??
    (await queryClient.ensureQueryData<AppConfig>({ queryKey: qk.config, queryFn: loadConfig }));
  const studioAssignments = { ...previous.studioAssignments };
  if (assignment) studioAssignments[sessionID] = assignment;
  else delete studioAssignments[sessionID];

  queryClient.setQueryData(qk.config, { ...previous, studioAssignments });
  try {
    await patchConfig({ studioAssignments });
  } catch (error) {
    queryClient.setQueryData(qk.config, previous);
    throw error;
  }
}

export function useStudioAssignments() {
  const queryClient = useQueryClient();
  const { data: config = DEFAULT_APP_CONFIG } = useQuery<AppConfig>({
    queryKey: qk.config,
    queryFn: loadConfig,
  });
  const assignments = config.studioAssignments ?? {};

  const setAssignment = useCallback(
    (sessionID: string, assignment: StudioAssignment | null) =>
      updateStudioAssignment(queryClient, sessionID, assignment),
    [queryClient],
  );

  return { assignments, setAssignment };
}
