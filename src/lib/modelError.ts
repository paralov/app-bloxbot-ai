import type { AssistantMessage } from "./opencode/types";

export type ModelError = NonNullable<AssistantMessage["error"]>;

export interface ModelErrorPresentation {
  kind: "context" | "auth" | "aborted" | "usage" | "region" | "unavailable" | "generic";
  title: string;
  description: string;
  detail?: string;
}

/** The provider's own words about a model error: its message, else its response body. */
export function modelErrorDetail(error: ModelError): string | undefined {
  const data = error.data as { message?: unknown; responseBody?: unknown };
  const detail = [data.message, data.responseBody].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return detail?.trim();
}

/** OpenCode puts the reason in the message or the response body, depending on where it failed. */
function errorSays(error: ModelError, pattern: RegExp): boolean {
  const data = error.data as { message?: unknown; responseBody?: unknown };
  return [data.message, data.responseBody].some(
    (value) => typeof value === "string" && pattern.test(value),
  );
}

/**
 * OpenCode's free tier refusing a prompt because the free messages are used up for now. The limit
 * is a rolling window per IP shared by every free model, so, despite OpenCode's own wording,
 * switching free models doesn't help.
 */
export function isFreeUsageLimit(error: ModelError): boolean {
  const data = error.data as { message?: unknown; responseBody?: unknown; type?: unknown };
  return (
    data.type === "provider.free-limit" ||
    (typeof data.responseBody === "string" && data.responseBody.includes("FreeUsageLimitError")) ||
    (typeof data.message === "string" && /free usage (limit|exceeded)/i.test(data.message))
  );
}

/** A model its provider won't serve where the user is. */
export function isRegionLocked(error: ModelError): boolean {
  return errorSays(error, /not available in your (country|region)/i);
}

/** A model OpenCode no longer serves, usually because it was retired. */
export function isModelUnavailable(error: ModelError): boolean {
  return errorSays(error, /model is (no longer )?unavailable/i);
}

function retryAfter(error: ModelError): number | undefined {
  const { retryAfterMs } = error.data as { retryAfterMs?: unknown };
  return typeof retryAfterMs === "number" && retryAfterMs > 0 ? retryAfterMs : undefined;
}

/**
 * How long to treat a free limit as current when OpenCode gives no delay. Chat turns carry Zen's
 * Retry-After, which was about 3 hours when measured on 2026-11-06; OpenCode 2.2.5 drops it from
 * helper prompts, so those fall back to this.
 */
export const FREE_LIMIT_FALLBACK_MS = 3 * 60 * 60 * 1000;

/**
 * When a free limit lifts: after OpenCode's retry delay, or a few hours if it gave none. The error
 * stays on its message for good, so this tells a current limit from an old one.
 */
export function freeLimitEndsAt(error: ModelError, hitAt: number): number {
  return hitAt + (retryAfter(error) ?? FREE_LIMIT_FALLBACK_MS);
}

function freeLimitReturn(error: ModelError, hitAt: number | undefined, now: number): string {
  const wait = retryAfter(error);
  if (wait === undefined) return "Free messages come back after a few hours.";
  const hours = Math.round((hitAt === undefined ? wait : hitAt + wait - now) / (60 * 60 * 1000));
  if (hours < 1) return "Free messages come back in less than an hour.";
  return `Free messages come back in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function presentModelError(
  error: ModelError,
  hitAt?: number,
  now = Date.now(),
): ModelErrorPresentation {
  const detail = modelErrorDetail(error);

  if (isFreeUsageLimit(error)) {
    return {
      kind: "usage",
      title: "You've used the free messages for now",
      description: `${freeLimitReturn(error, hitAt, now)} To keep going now, connect your own AI account, like ChatGPT or Claude, in Settings under Providers, or subscribe to OpenCode Go.`,
    };
  }

  if (isRegionLocked(error)) {
    return {
      kind: "region",
      title: "This model isn't offered in your region",
      description: "Switch to another model to keep going.",
      detail,
    };
  }

  if (isModelUnavailable(error)) {
    return {
      kind: "unavailable",
      title: "This model is no longer available",
      description: "It may have been removed. Switch to another model to keep going.",
      detail,
    };
  }

  if (error.name === "ContextOverflowError") {
    return {
      kind: "context",
      title: "This conversation is too large",
      description:
        "OpenCode could not reduce the conversation enough to fit this model. Start a new session or choose a model with a larger context window.",
      detail,
    };
  }

  if (error.name === "ProviderAuthError") {
    return {
      kind: "auth",
      title: "Provider connection needs attention",
      description: "Reconnect this provider or update its API key in Settings, then retry.",
      detail,
    };
  }

  if (error.name === "MessageAbortedError") {
    return {
      kind: "aborted",
      title: "Response stopped",
      description: detail ?? "The response was stopped before it finished.",
    };
  }

  return {
    kind: "generic",
    title: "The model could not respond",
    description:
      detail ?? "The provider returned an unexpected error. Try again or choose another model.",
  };
}
