import type { AssistantMessage, Model, Provider } from "@opencode-ai/sdk/v2/client";

import { splitModelKey } from "@/lib/splitModelKey";

/**
 * How the checked model relates to the user's setup: the model they chat
 * with, the provider's default, or another one they picked for the check.
 */
export type CheckModelChoice = "selected" | "default" | "other";

/** The models a check prefers: the user's chat model and the provider's default. */
export type CheckPreference = { selected?: string; default?: string };

/**
 * Whether a model can hold the check's conversation: text in, text out, and
 * tool calls, since the check is sent like a real chat with tools attached.
 * Image, embedding and speech models fail the check on a working key.
 */
export function canChat(model: Model): boolean {
  const { capabilities } = model;
  return (
    model.status !== "deprecated" &&
    capabilities?.toolcall === true &&
    capabilities.input?.text === true &&
    capabilities.output?.text === true
  );
}

/**
 * The preferred check models for one provider: the user's selected chat model
 * when it's from this provider, and the provider's default.
 */
export function checkPreference(
  providerID: string,
  selectedModel: string | null | undefined,
  defaults: Record<string, string> | undefined,
): CheckPreference {
  const [selectedProviderID, selectedModelID] = selectedModel ? splitModelKey(selectedModel) : [];
  return {
    selected: selectedProviderID === providerID ? selectedModelID : undefined,
    default: defaults?.[providerID],
  };
}

/**
 * The provider's models a check can run on, in the order the picker lists
 * them: the user's selected chat model, then the provider's default, then the
 * rest by name with alpha models last. A model that can't chat is never
 * listed: it would report a working connection as broken.
 */
export function checkModels(
  provider: Pick<Provider, "models">,
  preferred: CheckPreference = {},
): Model[] {
  const rank = (m: Model) =>
    m.id === preferred.selected ? 0 : m.id === preferred.default ? 1 : m.status === "alpha" ? 3 : 2;
  return Object.values(provider.models)
    .filter(canChat)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The model a check starts on (the first of checkModels). */
export function pickCheckModel(
  provider: Pick<Provider, "models">,
  preferred: CheckPreference = {},
): Model | undefined {
  return checkModels(provider, preferred)[0];
}

/** How a checked model relates to the user's setup, for analytics. */
export function checkModelChoice(modelID: string, preferred: CheckPreference): CheckModelChoice {
  if (modelID === preferred.selected) return "selected";
  if (modelID === preferred.default) return "default";
  return "other";
}

export type ProviderCheckResult =
  | { ok: true; modelName: string }
  | { ok: false; message: string; keyRejected: boolean; modelName?: string };

type ModelError = NonNullable<AssistantMessage["error"]>;

/** What a failed check tells the user, and whether a new key would fix it. */
export function checkFailure(error: ModelError): Extract<ProviderCheckResult, { ok: false }> {
  const data = error.data as { message?: unknown; responseBody?: unknown; statusCode?: unknown };
  const status = typeof data.statusCode === "number" ? data.statusCode : undefined;
  const keyRejected = error.name === "ProviderAuthError" || status === 401 || status === 403;
  const detail = [data.message, data.responseBody].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const message = detail?.trim() ?? "The provider didn't answer the test message.";
  return { ok: false, message, keyRejected };
}
