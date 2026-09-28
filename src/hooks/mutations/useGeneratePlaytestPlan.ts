import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ASK_ALL_PERMISSIONS, rejectPermissions } from "@/lib/hiddenSession";
import { modelErrorDetail } from "@/lib/modelError";
import {
  buildPlaytestHistory,
  NoPlaytestContextError,
  PLAYTEST_PLAN_SCHEMA,
  PlaytestPlannerError,
  parsePlaytestPlan,
} from "@/lib/playtestPlan";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import type { MessagesCache } from "@/lib/sseDispatch";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

/**
 * Builds a playtest plan from the active chat in a hidden, temporary session
 * whose tools never run, using OpenCode's structured output.
 */
export function useGeneratePlaytestPlan() {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const { selectedModel, selectedAgent, selectedVariant } = usePreferences();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!client || !activeSessionId) throw new Error("Open a chat before creating a playtest.");
      const cache = queryClient.getQueryData<MessagesCache>(qk.messages(activeSessionId));
      const messages = (cache?.messageIds ?? []).flatMap((id) => {
        const message = cache?.messagesById[id];
        return message ? [message] : [];
      });
      const history = buildPlaytestHistory(messages);
      if (!history) throw new NoPlaytestContextError();

      let model: { providerID: string; modelID: string } | undefined;
      if (selectedModel) {
        const [providerID, modelID] = splitModelKey(selectedModel);
        if (providerID && modelID) model = { providerID, modelID };
      }

      const created = await client.session.create(
        {
          title: "Playtest plan (temporary)",
          agent: selectedAgent ?? undefined,
          metadata: { bloxbotHidden: true, purpose: "playtest-plan" },
          permission: ASK_ALL_PERMISSIONS,
        },
        { throwOnError: true },
      );
      const planningSessionId = created.data?.id;
      if (!planningSessionId) throw new Error("Couldn't start the playtest planner.");

      const stopRejecting = rejectPermissions(client, planningSessionId);
      try {
        const response = await client.session.prompt(
          {
            sessionID: planningSessionId,
            model,
            agent: selectedAgent ?? undefined,
            variant: selectedVariant ?? undefined,
            format: { type: "json_schema", schema: PLAYTEST_PLAN_SCHEMA, retryCount: 2 },
            // OpenCode returns structured output through its StructuredOutput
            // tool, so that is the one tool the planner calls.
            system:
              "You create concise, practical Roblox playtest plans from conversation history. Answer only by calling the StructuredOutput tool once. Never call any other tool and never modify files or Roblox Studio.",
            parts: [
              {
                type: "text",
                text: `Create a focused playtest plan for the work described below. Make each step directly executable and each success criterion observable.\n\nCHAT HISTORY\n${history}`,
              },
            ],
          },
          { throwOnError: true },
        );
        const info = response.data?.info;
        if (info?.error) {
          throw new PlaytestPlannerError(
            modelErrorDetail(info.error) ?? "The planner's model didn't answer.",
            info.error.name,
          );
        }
        return parsePlaytestPlan(info?.structured);
      } finally {
        stopRejecting();
        await client.session.delete({ sessionID: planningSessionId }).catch(() => undefined);
      }
    },
  });
}
