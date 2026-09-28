import type { AssistantMessage, Model, Provider } from "@opencode-ai/sdk/v2/client";

/**
 * The model a connection check runs on: the cheapest one that isn't deprecated,
 * so checking a pay-per-use key costs as little as possible. Free models win.
 */
export function pickCheckModel(provider: Pick<Provider, "models">): Model | undefined {
  const models = Object.values(provider.models);
  const usable = models.filter((m) => m.status !== "deprecated");
  const pool = usable.length > 0 ? usable : models;
  return [...pool].sort(
    (a, b) =>
      a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id),
  )[0];
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
