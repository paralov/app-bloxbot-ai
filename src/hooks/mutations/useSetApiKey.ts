import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties, detailedAnalyticsProperties } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useSetApiKey() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ providerID, key }: { providerID: string; key: string }) => {
      if (!client) throw new Error("No client");
      await client.auth.set({ providerID, auth: { type: "api", key } }, { throwOnError: true });
      await client.instance.dispose({}, { throwOnError: true });
      // First call after dispose triggers server reinitialization; may return stale data
      await client.provider.list({}, { throwOnError: true });
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}, { throwOnError: true }),
        client.provider.auth({}, { throwOnError: true }).catch(() => ({ data: undefined })),
      ]);
      if (!provRes.data) throw new Error("No provider data after setting API key");
      const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
      queryClient.setQueryData(qk.providers, merged);
      posthog.capture(
        "provider_connected",
        analyticsProperties("providers", {
          outcome: "success",
          method: "api_key",
          ...detailedAnalyticsProperties({ provider: providerID }),
        }),
      );
    },
  });
}

export function useDisconnectProvider() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (providerID: string) => {
      if (!client) throw new Error("No client");
      await client.auth.remove({ providerID }, { throwOnError: true });
      await client.instance.dispose({}, { throwOnError: true });
      await client.provider.list({}, { throwOnError: true });
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}, { throwOnError: true }),
        client.provider.auth({}, { throwOnError: true }).catch(() => ({ data: undefined })),
      ]);
      if (!provRes.data) throw new Error("No provider data after disconnecting provider");
      const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
      queryClient.setQueryData(qk.providers, merged);
      posthog.capture(
        "provider_disconnected",
        analyticsProperties("providers", {
          outcome: "success",
          ...detailedAnalyticsProperties({ provider: providerID }),
        }),
      );
      return providerID;
    },
  });
}
