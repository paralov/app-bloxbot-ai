import type {
  AssistantMessage,
  Model,
  OpencodeClient,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties, detailedAnalyticsProperties } from "@/lib/analytics";
import { scrubErrorMessage } from "@/lib/errorReporting";
import {
  type CheckModel,
  checkFailure,
  checkModelCandidates,
  type ProviderCheckResult,
} from "@/lib/providerCheck";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

/**
 * Sends one short message through one of a provider's chat models (the user's
 * selected model if it's from this provider, else the provider's default, else
 * the cheapest one that can chat), the same way a chat would, to show whether
 * its key or sign-in actually works. If that model fails for a reason other
 * than the key, the next candidate gets one try, since the first model may just
 * be unavailable on the user's plan. Only runs when the user asks: checking on
 * save would spend their credits unasked.
 */
export function useCheckProvider() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const { selectedModel } = usePreferences();

  return useMutation({
    mutationFn: async (providerID: string): Promise<ProviderCheckResult> => {
      if (!client) throw new Error("No client");
      const providers = queryClient.getQueryData<ProviderListResponse>(qk.providers);
      const provider = providers?.all.find((p) => p.id === providerID);
      const [selectedProviderID, selectedModelID] = selectedModel
        ? splitModelKey(selectedModel)
        : [];
      const [firstCandidate, nextCandidate] = provider
        ? checkModelCandidates(provider, {
            selected: selectedProviderID === providerID ? selectedModelID : undefined,
            default: providers?.default[providerID],
          })
        : [];
      if (!firstCandidate) {
        return {
          ok: false,
          message: "This provider has no chat models to test with.",
          keyRejected: false,
        };
      }

      let candidate: CheckModel = firstCandidate;
      let attempt = await checkOnce(client, providerID, candidate.model);
      let first: { model: string; errorMessage: string } | undefined;
      // A different model can't fix a rejected key, so only other failures
      // get a second try.
      if (!attempt.result.ok && !attempt.result.keyRejected && nextCandidate) {
        first = {
          model: candidate.model.id,
          errorMessage: scrubErrorMessage(attempt.result.message),
        };
        candidate = nextCandidate;
        attempt = await checkOnce(client, providerID, candidate.model);
      }

      const { result, error } = attempt;
      posthog.capture(
        "provider_checked",
        analyticsProperties("providers", {
          outcome: result.ok ? "success" : "failure",
          model_choice: candidate.choice,
          attempts: first ? 2 : 1,
          ...(result.ok
            ? {}
            : {
                key_rejected: result.keyRejected,
                error_name: error?.name,
                error_message: scrubErrorMessage(result.message),
              }),
          ...(first ? { first_error_message: first.errorMessage } : {}),
          ...detailedAnalyticsProperties({
            provider: providerID,
            model: candidate.model.id,
            ...(first ? { first_model: first.model } : {}),
          }),
        }),
      );
      return result;
    },
  });
}

/**
 * Sends the check message to one model in a fresh hidden session, then removes
 * the session.
 */
async function checkOnce(
  client: OpencodeClient,
  providerID: string,
  model: Model,
): Promise<{ result: ProviderCheckResult; error?: AssistantMessage["error"] }> {
  const created = await client.session.create(
    {
      title: "BloxBot connection check",
      metadata: { bloxbotHidden: true, purpose: "provider-check" },
      // Every tool needs approval, and the check rejects every request, so
      // nothing runs. "deny" would be simpler but drops the tools from the
      // request, which OpenCode's free tier rejects.
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
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
    return {
      result: error ? checkFailure(error) : { ok: true, modelName: model.name },
      error,
    };
  } finally {
    stopRejecting();
    await client.session.delete({ sessionID }, { throwOnError: true }).catch(() => undefined);
  }
}

/**
 * Rejects every approval request from the check session until stopped. Hidden
 * sessions never show approval prompts, so without this a tool call would
 * leave the check waiting forever.
 */
function rejectPermissions(client: OpencodeClient, sessionID: string): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const pending = await client.permission.list({}).catch(() => undefined);
      for (const request of pending?.data ?? []) {
        if (request.sessionID !== sessionID) continue;
        await client.permission.reply({ requestID: request.id, reply: "reject" }).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, PERMISSION_POLL_MS));
    }
  })();
  return () => {
    stopped = true;
  };
}

const PERMISSION_POLL_MS = 250;
