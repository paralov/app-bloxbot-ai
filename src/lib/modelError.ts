import type { AssistantMessage } from "@opencode-ai/sdk/v2/client";

export type ModelError = NonNullable<AssistantMessage["error"]>;

export interface ModelErrorPresentation {
  kind: "context" | "auth" | "aborted" | "generic";
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

export function presentModelError(error: ModelError): ModelErrorPresentation {
  const detail = modelErrorDetail(error);

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
