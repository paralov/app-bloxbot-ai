import type { ProviderListResponse } from "@/lib/opencode/types";
import { isFreeTier } from "@/lib/providerAuth";
import { splitModelKey } from "@/lib/splitModelKey";

export interface ModelChoice {
  key: string;
  name: string;
}

/** The listed model a "provider/model" key names, if OpenCode still offers it. */
function listedModel(list: ProviderListResponse, key: string) {
  const [providerID, modelID] = splitModelKey(key);
  const provider = list.all.find((candidate) => candidate.id === providerID);
  return provider && Object.values(provider.models).find((model) => model.id === modelID);
}

export function modelName(list: ProviderListResponse | undefined, key: string): string {
  return (list && listedModel(list, key)?.name) ?? splitModelKey(key)[1];
}

/**
 * Another free model to move to. Skips the ones to avoid (the one that failed, the one selected)
 * and the ones that can't work here, and prefers OpenCode's default, then one out of alpha or beta.
 */
export function pickFreeModel(
  list: ProviderListResponse,
  options: {
    avoid: ReadonlyArray<string | null | undefined>;
    unavailable: ReadonlySet<string>;
    hidden?: ReadonlySet<string>;
  },
): ModelChoice | undefined {
  const avoid = new Set(options.avoid);
  const candidates = list.all
    .filter((provider) => isFreeTier(provider) && list.connected.includes(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        key: `${provider.id}/${model.id}`,
        name: model.name,
        isDefault: list.default[provider.id] === model.id,
        isPreview: model.status === "alpha" || model.status === "beta",
        isDeprecated: model.status === "deprecated",
      })),
    )
    .filter(
      (model) =>
        !model.isDeprecated &&
        !avoid.has(model.key) &&
        !options.unavailable.has(model.key) &&
        !options.hidden?.has(model.key),
    );
  // Lower is better, in the order of preference above.
  const rank = (model: (typeof candidates)[number]) =>
    (model.isDefault ? 0 : 2) + (model.isPreview ? 1 : 0);
  const choice = candidates.sort((a, b) => rank(a) - rank(b))[0];
  return choice && { key: choice.key, name: choice.name };
}

/**
 * Why a saved model can't be used any more, if it can't: OpenCode stopped listing it, or it was
 * refused in the user's region. A model whose provider isn't listed is left to the caller.
 */
export function goneReason(
  list: ProviderListResponse,
  key: string,
  unavailable: ReadonlySet<string>,
): "retired" | "region" | undefined {
  const [providerID] = splitModelKey(key);
  if (!list.all.some((provider) => provider.id === providerID)) return undefined;
  if (!listedModel(list, key)) return "retired";
  if (unavailable.has(key)) return "region";
  return undefined;
}

/**
 * Where a chat goes when its model is gone: its provider's default, as OpenCode would pick with no
 * model set, else another free model. Null leaves the choice to OpenCode.
 */
export function replacementModel(
  list: ProviderListResponse,
  key: string,
  unavailable: ReadonlySet<string>,
): ModelChoice | null {
  const [providerID] = splitModelKey(key);
  const fallback = list.default[providerID];
  const fallbackKey = fallback ? `${providerID}/${fallback}` : undefined;
  if (fallbackKey && fallbackKey !== key && !goneReason(list, fallbackKey, unavailable)) {
    return { key: fallbackKey, name: modelName(list, fallbackKey) };
  }
  return pickFreeModel(list, { avoid: [key], unavailable }) ?? null;
}
