import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties, detailedAnalyticsProperties } from "@/lib/analytics";
import { scrubErrorMessage } from "@/lib/errorReporting";
import { ASK_ALL_PERMISSIONS, rejectPermissions } from "@/lib/hiddenSession";
import {
  canChat,
  checkFailure,
  checkModelChoice,
  checkPreference,
  type ProviderCheckResult,
} from "@/lib/providerCheck";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

export type CheckProviderInput = { providerID: string; modelID: string };

/**
 * Sends one short message through the chat model the user picked, the same
 * way a chat would, to show whether the provider's key or sign-in works with
 * it. Only runs when the user asks: checking on save would spend their
 * credits unasked.
 */
export function useCheckProvider() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { selectedModel } = usePreferences();

  return useMutation({
    mutationFn: async ({
      providerID,
      modelID,
    }: CheckProviderInput): Promise<ProviderCheckResult> => {
      if (!client) throw new Error("No client");
      const providers = queryClient.getQueryData<ProviderListResponse>(qk.providers);
      const provider = providers?.all.find((p) => p.id === providerID);
      const model = provider?.models[modelID];
      if (!model || !canChat(model)) {
        return {
          ok: false,
          message: "This model can't be tested. Pick one that can chat.",
          keyRejected: false,
        };
      }

      const created = await client.session.create(
        {
          title: "BloxBot connection check",
          metadata: { bloxbotHidden: true, purpose: "provider-check" },
          permission: ASK_ALL_PERMISSIONS,
        },
        { throwOnError: true },
      );
      const sessionID = created.data.id;
      const stopRejecting = rejectPermissions(client, sessionID);
      try {
        // A normal-shaped request: OpenCode's free tier and Go reject traffic
        // that doesn't look like a coding agent's.
        const response = await client.session.prompt(
          {
            sessionID,
            model: { providerID, modelID: model.id },
            parts: [{ type: "text", text: "Connection check. Reply with OK and nothing else." }],
          },
          { throwOnError: true },
        );
        const error = response.data.info.error;
        const result: ProviderCheckResult = error
          ? { ...checkFailure(error), modelName: model.name }
          : { ok: true, modelName: model.name };
        posthog.capture(
          "provider_checked",
          analyticsProperties("providers", {
            outcome: result.ok ? "success" : "failure",
            model_choice: checkModelChoice(
              model.id,
              checkPreference(providerID, selectedModel, providers?.default),
            ),
            ...(result.ok
              ? {}
              : {
                  key_rejected: result.keyRejected,
                  error_name: error?.name,
                  error_message: scrubErrorMessage(result.message),
                }),
            ...detailedAnalyticsProperties({ provider: providerID, model: model.id }),
          }),
        );
        return result;
      } finally {
        stopRejecting();
        await client.session.delete({ sessionID }, { throwOnError: true }).catch(() => undefined);
      }
    },
  });
}
