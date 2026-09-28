import type { AssistantMessage, Model, Provider } from "@opencode-ai/sdk/v2/client";

/** Why a check ran on the model it did; reported with the check's outcome. */
export type CheckModelChoice = "selected" | "default" | "cheapest";

export type CheckModel = { model: Model; choice: CheckModelChoice };

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
 * Whether a model is likely limited to a higher plan tier (such as OpenAI's
 * "-pro" models on a ChatGPT sign-in), so a working key or sign-in can still
 * fail on it.
 */
export function isTierGated(model: Pick<Model, "id">): boolean {
  return model.id.endsWith("-pro") || model.id.includes("-pro-");
}

type CheckPreference = { selected?: string; default?: string };

/**
 * The models a connection check can run on, best first. The user's selected
 * chat model comes first (it's what they actually use), then the provider's
 * default, then the cheapest models that can chat, so checking a pay-per-use
 * key costs little. Tier-gated models and then alpha models go last, since a
 * working key can fail on them, and a tier-gated default waits with them. A
 * model that can't chat is never listed: it would report a working
 * connection as broken.
 */
export function checkModelCandidates(
  provider: Pick<Provider, "models">,
  preferred: CheckPreference = {},
): CheckModel[] {
  const find = (id?: string) => {
    const model = id ? provider.models[id] : undefined;
    return model && canChat(model) ? model : undefined;
  };
  const selected = find(preferred.selected);
  const fallback = find(preferred.default);
  // Alpha last, tier-gated before it; the default keeps first place unless
  // it's tier-gated, and otherwise leads its own group.
  const group = (m: Model) =>
    m === fallback && !isTierGated(m) ? -1 : m.status === "alpha" ? 2 : isTierGated(m) ? 1 : 0;
  const rest = Object.values(provider.models)
    .filter((m) => canChat(m) && m !== selected)
    .sort(
      (a, b) =>
        group(a) - group(b) ||
        Number(b === fallback) - Number(a === fallback) ||
        a.cost.input + a.cost.output - (b.cost.input + b.cost.output) ||
        a.id.localeCompare(b.id),
    );
  return [
    ...(selected ? [{ model: selected, choice: "selected" as const }] : []),
    ...rest.map((model) => ({
      model,
      choice: model === fallback ? ("default" as const) : ("cheapest" as const),
    })),
  ];
}

/** The first model a connection check runs on (see checkModelCandidates). */
export function pickCheckModel(
  provider: Pick<Provider, "models">,
  preferred: CheckPreference = {},
): CheckModel | undefined {
  return checkModelCandidates(provider, preferred)[0];
}

export type ProviderCheckResult =
  | { ok: true; modelName: string }
  | { ok: false; message: string; keyRejected: boolean };

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
