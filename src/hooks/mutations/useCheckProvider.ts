import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties, detailedAnalyticsProperties } from "@/lib/analytics";
import { checkFailure, type ProviderCheckResult, pickCheckModel } from "@/lib/providerCheck";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

/**
 * Sends one short message through a provider's cheapest model, the same way a
 * chat would, to show whether its key or sign-in actually works. Only runs when
 * the user asks: checking on save would spend their credits unasked.
 */
export function useCheckProvider() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (providerID: string): Promise<ProviderCheckResult> => {
      if (!client) throw new Error("No client");
      const providers = queryClient.getQueryData<ProviderListResponse>(qk.providers);
      const provider = providers?.all.find((p) => p.id === providerID);
      const model = provider ? pickCheckModel(provider) : undefined;
      if (!model) {
        return {
          ok: false,
          message: "This provider has no models to test with.",
          keyRejected: false,
        };
      }

      const created = await client.session.create(
        {
          title: "BloxBot connection check",
          metadata: { bloxbotHidden: true, purpose: "provider-check" },
        },
        { throwOnError: true },
      );
      const sessionID = created.data.id;
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
          ? checkFailure(error)
          : { ok: true, modelName: model.name };
        posthog.capture(
          "provider_checked",
          analyticsProperties("providers", {
            outcome: result.ok ? "success" : "failure",
            ...(result.ok ? {} : { key_rejected: result.keyRejected, error_name: error?.name }),
            ...detailedAnalyticsProperties({ provider: providerID, model: model.id }),
          }),
        );
        return result;
      } finally {
        await client.session.delete({ sessionID }, { throwOnError: true }).catch(() => undefined);
      }
    },
  });
}
