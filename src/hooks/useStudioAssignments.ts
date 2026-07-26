import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { loadConfig, patchConfig } from "@/lib/config";
import { qk } from "@/lib/queryKeys";
import { disconnectSessionStudioServer } from "@/lib/studioRouting";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { type AppConfig, DEFAULT_APP_CONFIG, type StudioAssignment } from "@/types/desktop";

const updateQueues = new WeakMap<QueryClient, Promise<void>>();

export function staleStudioAssignmentIDs(
  assignments: Record<string, StudioAssignment>,
  existingSessionIDs: ReadonlySet<string>,
): string[] {
  return Object.keys(assignments).filter((sessionID) => !existingSessionIDs.has(sessionID));
}

async function performStudioAssignmentUpdate(
  queryClient: QueryClient,
  sessionID: string,
  assignment: StudioAssignment | null,
): Promise<void> {
  const loaded =
    queryClient.getQueryData<AppConfig>(qk.config) ??
    (await queryClient.ensureQueryData<AppConfig>({ queryKey: qk.config, queryFn: loadConfig }));
  const previousAssignment = loaded.studioAssignments?.[sessionID];
  const studioAssignments = { ...loaded.studioAssignments };
  if (assignment) studioAssignments[sessionID] = assignment;
  else delete studioAssignments[sessionID];

  queryClient.setQueryData<AppConfig>(qk.config, { ...loaded, studioAssignments });
  try {
    await patchConfig({ studioAssignments });
  } catch (error) {
    queryClient.setQueryData<AppConfig>(qk.config, (current) => {
      const restoredAssignments = { ...(current ?? loaded).studioAssignments };
      if (previousAssignment) restoredAssignments[sessionID] = previousAssignment;
      else delete restoredAssignments[sessionID];
      return { ...(current ?? loaded), studioAssignments: restoredAssignments };
    });
    throw error;
  }
}

export async function updateStudioAssignment(
  queryClient: QueryClient,
  sessionID: string,
  assignment: StudioAssignment | null,
): Promise<void> {
  const previous = updateQueues.get(queryClient) ?? Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(() => performStudioAssignmentUpdate(queryClient, sessionID, assignment));
  updateQueues.set(queryClient, update);
  try {
    await update;
  } finally {
    if (updateQueues.get(queryClient) === update) updateQueues.delete(queryClient);
  }
}

export function useStudioAssignments() {
  const queryClient = useQueryClient();
  const { client } = useOpenCodeClient();
  const { data: config = DEFAULT_APP_CONFIG } = useQuery<AppConfig>({
    queryKey: qk.config,
    queryFn: loadConfig,
  });

  const setAssignment = useCallback(
    async (sessionID: string, assignment: StudioAssignment | null) => {
      await updateStudioAssignment(queryClient, sessionID, assignment);
      if (!assignment && client) {
        try {
          await disconnectSessionStudioServer(client, sessionID);
        } catch {
          await disconnectSessionStudioServer(client, sessionID);
        }
      }
    },
    [client, queryClient],
  );

  return { assignments: config.studioAssignments ?? {}, setAssignment };
}
