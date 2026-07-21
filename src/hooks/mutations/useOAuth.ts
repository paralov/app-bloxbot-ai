import { usePostHog } from "@posthog/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { detailedAnalyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

export function useStartOAuth() {
  const { client } = useOpenCodeClient();

  return useMutation({
    mutationFn: async ({
      providerID,
      methodIndex,
    }: {
      providerID: string;
      methodIndex: number;
    }) => {
      if (!client) throw new Error("No client");
      const res = await client.provider.oauth.authorize(
        { providerID, method: methodIndex },
        { throwOnError: true },
      );
      if (!res.data) return undefined;
      // The sidecar cannot open a browser itself, so use the safe desktop bridge.
      if (res.data.url) {
        await desktop.openUrl(res.data.url);
      }
      return { method: res.data.method, instructions: res.data.instructions, url: res.data.url };
    },
  });
}

export function useCompleteOAuth() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const posthog = usePostHog();

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
      await client.instance.dispose({}, { throwOnError: true });

      await client.provider.list({}, { throwOnError: true });
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}, { throwOnError: true }),
        client.provider.auth({}, { throwOnError: true }).catch(() => ({ data: undefined })),
      ]);
      if (!provRes.data) throw new Error("No provider data after OAuth");
      const merged = authRes.data ? { ...provRes.data, authMethods: authRes.data } : provRes.data;
      queryClient.setQueryData(qk.providers, merged);

      if (res.data === true) {
        posthog.capture("provider_connected", {
          method: "oauth",
          ...detailedAnalyticsProperties({ provider: providerID }),
        });
      }
      return res.data === true;
    },
  });
}
