import type {
  ProviderAuthMethod,
  ProviderAuthResponse,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client";
import { useQuery } from "@tanstack/react-query";

import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import type { ModelInfo, ProviderInfo } from "@/types";

type ProvidersData = ProviderListResponse & {
  authMethods?: Record<string, ProviderAuthMethod[]>;
};

function useProvidersQuery() {
  const { client } = useOpenCodeClient();

  return useQuery<ProvidersData>({
    queryKey: qk.providers,
    queryFn: async () => {
      if (!client) throw new Error("No client");
      const [provRes, authRes] = await Promise.all([
        client.provider.list({}, { throwOnError: true }),
        client.provider
          .auth({}, { throwOnError: true })
          .catch(() => ({ data: undefined as ProviderAuthResponse | undefined })),
      ]);
      if (!provRes.data) throw new Error("No provider data");
      if (authRes.data) {
        return { ...provRes.data, authMethods: authRes.data };
      }
      return provRes.data;
    },
    enabled: !!client,
  });
}

export function useAllProviders(): ProviderInfo[] {
  const { data } = useProvidersQuery();
  if (!data?.all) return [];
  return data.all.map((p) => ({ id: p.id, name: p.name, env: p.env }));
}

export function useConnectedProviders(): string[] {
  const { data } = useProvidersQuery();
  return data?.connected ?? [];
}

export function useAllModels(): ModelInfo[] {
  const { data } = useProvidersQuery();
  if (!data?.all) return [];
  const models: ModelInfo[] = [];
  for (const provider of data.all) {
    for (const model of Object.values(provider.models)) {
      models.push({
        id: model.id,
        name: model.name,
        providerId: provider.id,
        providerName: provider.name,
        status: model.status,
        variants: model.variants,
      });
    }
  }
  return models;
}

export function useAuthMethods(): Record<string, ProviderAuthMethod[]> {
  const { data } = useProvidersQuery();
  return data?.authMethods ?? {};
}
