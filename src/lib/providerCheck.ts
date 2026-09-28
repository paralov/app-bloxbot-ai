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
 * The model a connection check runs on. The user's selected chat model comes
 * first (it's what they actually use), then the provider's default, then the
 * cheapest model that can chat, so checking a pay-per-use key costs little.
 * A model that can't chat is never picked: it would report a working
 * connection as broken.
 */
export function pickCheckModel(
  provider: Pick<Provider, "models">,
  preferred: { selected?: string; default?: string } = {},
): CheckModel | undefined {
  for (const choice of ["selected", "default"] as const) {
    const id = preferred[choice];
    const model = id ? provider.models[id] : undefined;
    if (model && canChat(model)) return { model, choice };
  }
  const usable = Object.values(provider.models).filter(canChat);
  const stable = usable.filter((m) => m.status !== "alpha");
  const model = [...(stable.length > 0 ? stable : usable)].sort(
    (a, b) =>
      a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id),
  )[0];
  return model ? { model, choice: "cheapest" } : undefined;
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
