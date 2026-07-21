import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { detailedAnalyticsProperties } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useSetApiKey() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ providerID, key }: { providerID: string; key: string }) => {
      if (!client) throw new Error("No client");
      await client.auth.set({ providerID, auth: { type: "api", key } });
      await client.instance.dispose();
      // First call after dispose triggers server reinitialization; may return stale data
      await client.provider.list({});
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}),
        client.provider.auth({}).catch(() => ({ data: undefined })),
      ]);
      if (provRes.data) {
        const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
        queryClient.setQueryData(qk.providers, merged);
      }
      posthog.capture("provider_connected", {
        method: "api_key",
        ...detailedAnalyticsProperties({ provider: providerID }),
      });
    },
  });
}

export function useDisconnectProvider() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async (providerID: string) => {
      if (!client) throw new Error("No client");
      await client.auth.remove({ providerID });
      await client.instance.dispose();
      await client.provider.list({});
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}),
        client.provider.auth({}).catch(() => ({ data: undefined })),
      ]);
      if (provRes.data) {
        const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
        queryClient.setQueryData(qk.providers, merged);
      }
      posthog.capture(
        "provider_disconnected",
        detailedAnalyticsProperties({ provider: providerID }),
      );
      return providerID;
    },
  });
}
