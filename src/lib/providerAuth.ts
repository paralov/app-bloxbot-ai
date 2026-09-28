import type { ProviderAuthMethod } from "@opencode-ai/sdk/v2/client";

export type AuthPrompt = NonNullable<ProviderAuthMethod["prompts"]>[number];

export interface AuthMethodOption {
  index: number;
  type: ProviderAuthMethod["type"];
  /** OpenCode's own label for the method. */
  label: string;
  title: string;
  description?: string;
  prompts: AuthPrompt[];
}

// OpenCode labels are written for its terminal UI; these read better as buttons.
const METHOD_COPY: Record<string, Record<string, { title: string; description: string }>> = {
  openai: {
    "ChatGPT Pro/Plus (browser)": {
      title: "Sign in with ChatGPT",
      description: "Use your ChatGPT Plus or Pro plan. Opens your browser.",
    },
    "ChatGPT Pro/Plus (headless)": {
      title: "Sign in with a device code",
      description: "Use your ChatGPT plan by entering a code on openai.com.",
    },
    "Manually enter API Key": {
      title: "Use an OpenAI API key",
      description: "Pay per use with a key from platform.openai.com.",
    },
  },
};

/**
 * Every way a provider can be connected, in OpenCode's order. Providers that
 * report no methods still accept an API key.
 */
export function authMethodOptions(
  providerId: string,
  methods: ProviderAuthMethod[] | undefined,
): AuthMethodOption[] {
  if (!methods || methods.length === 0) {
    return [{ index: -1, type: "api", label: "API key", title: "Use an API key", prompts: [] }];
  }
  return methods.map((method, index) => {
    const copy = METHOD_COPY[providerId]?.[method.label];
    return {
      index,
      type: method.type,
      label: method.label,
      title: copy?.title ?? (method.type === "api" ? "Use an API key" : method.label),
      description: copy?.description,
      prompts: method.prompts ?? [],
    };
  });
}

/** The prompts to show given the answers so far; `when` hides follow-up questions. */
export function visiblePrompts(prompts: AuthPrompt[], inputs: Record<string, string>) {
  return prompts.filter((prompt) => {
    if (!prompt.when) return true;
    const value = inputs[prompt.when.key];
    return prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
  });
}

/** Default answers, so select prompts start on their first option. */
export function initialPromptInputs(prompts: AuthPrompt[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const prompt of prompts) {
    if (prompt.type === "select" && prompt.options[0]) inputs[prompt.key] = prompt.options[0].value;
  }
  return inputs;
}

/** Only the answers to prompts that are still visible, so hidden answers never reach OpenCode. */
export function submittedPromptInputs(prompts: AuthPrompt[], inputs: Record<string, string>) {
  const submitted: Record<string, string> = {};
  for (const prompt of visiblePrompts(prompts, inputs)) {
    const value = inputs[prompt.key]?.trim();
    if (value) submitted[prompt.key] = value;
  }
  return submitted;
}

// OpenCode answers unexpected failures with this placeholder, which tells a user nothing.
const GENERIC_SERVER_MESSAGE = /^Unexpected server error/i;

/** The message worth showing from an SDK error body or a thrown Error, if any. */
export function authErrorMessage(error: unknown): string | undefined {
  let message: unknown;
  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { message?: unknown } }).data;
    message = data?.message;
  }
  if (typeof message !== "string") return undefined;
  const trimmed = message.trim();
  if (!trimmed || GENERIC_SERVER_MESSAGE.test(trimmed)) return undefined;
  return trimmed;
}

/** A device-code sign-in shows a short code such as `2T75-15CTI` in its instructions. */
export function deviceCode(instructions: string | null | undefined): string | null {
  return instructions?.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/i)?.[0] ?? null;
}

export interface OAuthRecovery {
  hint: string;
  /** The method to steer the user toward next, if there is a better one. */
  suggestedIndex?: number;
}

/**
 * What to tell a user after a sign-in fails. ChatGPT's browser sign-in listens on
 * the same local port as the Codex app and CLI, and once it has failed OpenCode
 * keeps handing out sign-in links that can never complete. The device code
 * sign-in does not need the port, so point there.
 */
export function oauthRecovery(
  providerId: string,
  method: AuthMethodOption | undefined,
  options: AuthMethodOption[],
): OAuthRecovery {
  if (providerId === "openai" && method?.label === "ChatGPT Pro/Plus (browser)") {
    const deviceCodeOption = options.find((o) => o.label === "ChatGPT Pro/Plus (headless)");
    if (deviceCodeOption) {
      return {
        hint: "This usually means the Codex app or Codex CLI is open. Sign in with a device code instead, or quit Codex and restart BloxBot.",
        suggestedIndex: deviceCodeOption.index,
      };
    }
  }
  return { hint: "Try again, or pick another way to connect." };
}

const CONNECT_HINTS: Record<string, string> = {
  opencode: "Free models, or an OpenCode Zen key",
  openai: "ChatGPT Plus or Pro plan, or an API key",
  "github-copilot": "GitHub Copilot subscription",
};

/** One line on how a provider connects, so plan holders can find their way in. */
export function connectHint(providerId: string, methods: ProviderAuthMethod[] | undefined) {
  if (CONNECT_HINTS[providerId]) return CONNECT_HINTS[providerId];
  const hasOAuth = methods?.some((m) => m.type === "oauth") ?? false;
  const hasApi = !methods || methods.length === 0 || methods.some((m) => m.type === "api");
  if (hasOAuth && hasApi) return "Sign in or use an API key";
  if (hasOAuth) return "Sign in with your account";
  return "API key";
}
