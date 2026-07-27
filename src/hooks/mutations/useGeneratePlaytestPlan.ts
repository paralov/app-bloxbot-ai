import { useMutation, useQueryClient } from "@tanstack/react-query";
import { buildPlaytestHistory, PLAYTEST_PLAN_SCHEMA, parsePlaytestPlan } from "@/lib/playtestPlan";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import type { MessagesCache } from "@/lib/sseDispatch";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

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
      if (!history) throw new Error("Add some chat context before creating a playtest.");

      let model: { providerID: string; modelID: string } | undefined;
      if (selectedModel) {
        const [providerID, modelID] = splitModelKey(selectedModel);
        if (providerID && modelID) model = { providerID, modelID };
      }

      const created = await client.session.create(
        {
          title: "Playtest plan (temporary)",
          agent: selectedAgent ?? undefined,
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        },
        { throwOnError: true },
      );
      const planningSessionId = created.data?.id;
      if (!planningSessionId) throw new Error("Couldn't start the playtest planner.");

      try {
        const response = await client.session.prompt(
          {
            sessionID: planningSessionId,
            model,
            agent: selectedAgent ?? undefined,
            variant: selectedVariant ?? undefined,
            format: { type: "json_schema", schema: PLAYTEST_PLAN_SCHEMA, retryCount: 2 },
            system:
              "You create concise, practical Roblox playtest plans from conversation history. Return only the requested structured data. Never call tools and never modify files or Roblox Studio.",
            parts: [
              {
                type: "text",
                text: `Create a focused playtest plan for the work described below. Make each step directly executable and each success criterion observable.\n\nCHAT HISTORY\n${history}`,
              },
            ],
          },
          { throwOnError: true },
        );
        return parsePlaytestPlan(response.data?.info.structured);
      } finally {
        await client.session.delete({ sessionID: planningSessionId }).catch(() => undefined);
      }
    },
  });
}
