import type { AssistantMessage } from "./opencode/types";

export type ModelError = NonNullable<AssistantMessage["error"]>;

export interface ModelErrorPresentation {
  kind: "context" | "auth" | "aborted" | "usage" | "generic";
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

/** OpenCode's free tier refusing a prompt because the day's free messages are used up. */
export function isFreeUsageLimit(error: ModelError): boolean {
  const data = error.data as { message?: unknown; responseBody?: unknown };
  return (
    (typeof data.responseBody === "string" && data.responseBody.includes("FreeUsageLimitError")) ||
    (typeof data.message === "string" && /free usage (limit|exceeded)/i.test(data.message))
  );
}

/**
 * When a free limit lifts: after OpenCode's retry delay, or the next day if it gave none. The error
 * stays on its message for good, so this tells a current limit from an old one.
 */
export function freeLimitEndsAt(error: ModelError, hitAt: number): number {
  const { retryAfterMs } = error.data as { retryAfterMs?: unknown };
  const wait =
    typeof retryAfterMs === "number" && retryAfterMs > 0 ? retryAfterMs : 24 * 60 * 60 * 1000;
  return hitAt + wait;
}

function freeLimitReset(error: ModelError, hitAt: number | undefined, now: number): string {
  const { retryAfterMs } = error.data as { retryAfterMs?: unknown };
  if (typeof retryAfterMs !== "number" || retryAfterMs <= 0) return "They reset daily.";
  const hours = Math.round(
    (hitAt === undefined ? retryAfterMs : freeLimitEndsAt(error, hitAt) - now) / (60 * 60 * 1000),
  );
  if (hours < 1) return "They reset in less than an hour.";
  return `They reset in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
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
      title: "You've used today's free messages",
      description: `${freeLimitReset(error, hitAt, now)} To keep going now, connect a provider in Settings or subscribe to OpenCode Go.`,
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
