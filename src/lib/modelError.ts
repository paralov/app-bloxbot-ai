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

function freeLimitReset(error: ModelError): string {
  const { retryAfterMs } = error.data as { retryAfterMs?: unknown };
  if (typeof retryAfterMs !== "number" || retryAfterMs <= 0) return "They reset daily.";
  const hours = Math.round(retryAfterMs / (60 * 60 * 1000));
  if (hours < 1) return "They reset in less than an hour.";
  return `They reset in about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

export function presentModelError(error: ModelError): ModelErrorPresentation {
  const detail = modelErrorDetail(error);

  if (isFreeUsageLimit(error)) {
    return {
      kind: "usage",
      title: "You've used today's free messages",
      description: `${freeLimitReset(error)} To keep going now, connect a provider in Settings or subscribe to OpenCode Go.`,
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
