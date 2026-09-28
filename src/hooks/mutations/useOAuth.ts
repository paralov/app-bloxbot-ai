import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import {
  analyticsProperties,
  detailedAnalyticsProperties,
  errorAnalyticsProperties,
} from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useStartOAuth() {
  const { client } = useOpenCodeClient();

  return useMutation({
    mutationFn: async ({
      providerID,
      methodIndex,
      inputs,
    }: {
      providerID: string;
      methodIndex: number;
      inputs?: Record<string, string>;
    }) => {
      if (!client) throw new Error("No client");
      const res = await client.provider.oauth.authorize(
        {
          providerID,
          method: methodIndex,
          ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
        },
        { throwOnError: true },
      );
      if (!res.data) return undefined;
      // The caller opens res.data.url through the desktop bridge once it knows
      // the user is still waiting for this sign-in.
      return { method: res.data.method, instructions: res.data.instructions, url: res.data.url };
    },
  });
}

export function useCompleteOAuth() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      providerID,
      methodIndex,
      code,
    }: {
      providerID: string;
      methodIndex: number;
      code?: string;
    }) => {
      if (!client) throw new Error("No client");
      const res = await client.provider.oauth.callback(
        {
          providerID,
          method: methodIndex,
          ...(code ? { code } : {}),
        },
        { throwOnError: true },
      );
      if (res.data !== true) return false;

      // The credential is saved at this point. A failed refresh must not report the
      // sign-in as failed, so fall back to refetching the provider list.
      try {
        await client.instance.dispose({}, { throwOnError: true });
        // First call after dispose triggers server reinitialization; may return stale data
        await client.provider.list({}, { throwOnError: true });
        const [provRes, authRes] = await Promise.all([
          client.provider.list({}, { throwOnError: true }),
          client.provider.auth({}, { throwOnError: true }).catch(() => ({ data: undefined })),
        ]);
        if (!provRes.data) throw new Error("No provider data after OAuth");
        const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
        queryClient.setQueryData(qk.providers, merged);
      } catch {
        await queryClient.invalidateQueries({ queryKey: qk.providers });
      }

      posthog.capture(
        "provider_connected",
        analyticsProperties("providers", {
          outcome: "success",
          method: "oauth",
          ...detailedAnalyticsProperties({ provider: providerID }),
        }),
      );
      return true;
    },
  });
}

/** Records where a provider connection failed; before this only successes were tracked. */
export function captureProviderConnectFailure(
  providerID: string,
  phase: "oauth_start" | "oauth_complete" | "api_key",
  error: unknown,
  authMethod?: string,
) {
  posthog.capture(
    "provider_connect_failed",
    errorAnalyticsProperties("providers", phase, error, {
      // SDK failures arrive as response bodies such as { name: "ProviderAuthOauthCallbackFailed" }.
      error_name: errorName(error),
      method: phase === "api_key" ? "api_key" : "oauth",
      ...detailedAnalyticsProperties({ provider: providerID, auth_method: authMethod }),
    }),
  );
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return undefined;
}
