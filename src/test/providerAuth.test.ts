import type { ProviderAuthMethod } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import {
  authErrorMessage,
  authMethodOptions,
  connectHint,
  deviceCode,
  initialPromptInputs,
  oauthRecovery,
  providerDisplayName,
  submittedPromptInputs,
  visiblePrompts,
} from "@/lib/providerAuth";

// What OpenCode 1.18 reports for OpenAI.
const OPENAI_METHODS: ProviderAuthMethod[] = [
  { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
  { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
  { type: "api", label: "Manually enter API Key" },
];

const COPILOT_PROMPTS: NonNullable<ProviderAuthMethod["prompts"]> = [
  {
    type: "select",
    key: "deploymentType",
    message: "Select GitHub deployment type",
    options: [
      { label: "GitHub.com", value: "github.com", hint: "Public" },
      { label: "GitHub Enterprise", value: "enterprise" },
    ],
  },
  {
    type: "text",
    key: "enterpriseUrl",
    message: "Enter your GitHub Enterprise URL or domain",
    when: { key: "deploymentType", op: "eq", value: "enterprise" },
  },
];

describe("authMethodOptions", () => {
  it("offers every OpenAI method, including the device code sign-in", () => {
    const options = authMethodOptions("openai", OPENAI_METHODS);

    expect(options.map((o) => [o.index, o.type, o.title])).toEqual([
      [0, "oauth", "Sign in with ChatGPT"],
      [1, "oauth", "Sign in with a device code"],
      [2, "api", "Use an OpenAI API key"],
    ]);
  });

  it("falls back to OpenCode's labels for other providers", () => {
    const options = authMethodOptions("gitlab", [
      { type: "oauth", label: "GitLab OAuth" },
      { type: "api", label: "GitLab Personal Access Token" },
    ]);

    expect(options.map((o) => o.title)).toEqual(["GitLab OAuth", "Use an API key"]);
  });

  it("accepts an API key when a provider reports no methods", () => {
    expect(authMethodOptions("groq", undefined)).toMatchObject([{ type: "api" }]);
    expect(authMethodOptions("groq", [])).toMatchObject([{ type: "api" }]);
  });
});

describe("auth prompts", () => {
  it("starts select prompts on their first option", () => {
    expect(initialPromptInputs(COPILOT_PROMPTS)).toEqual({ deploymentType: "github.com" });
  });

  it("shows follow-up prompts only when their condition holds", () => {
    expect(visiblePrompts(COPILOT_PROMPTS, { deploymentType: "github.com" })).toHaveLength(1);
    expect(visiblePrompts(COPILOT_PROMPTS, { deploymentType: "enterprise" })).toHaveLength(2);
  });

  it("drops answers to hidden prompts and trims the rest", () => {
    expect(
      submittedPromptInputs(COPILOT_PROMPTS, {
        deploymentType: "github.com",
        enterpriseUrl: "left over from before",
      }),
    ).toEqual({ deploymentType: "github.com" });
    expect(
      submittedPromptInputs(COPILOT_PROMPTS, {
        deploymentType: "enterprise",
        enterpriseUrl: "  company.ghe.com ",
      }),
    ).toEqual({ deploymentType: "enterprise", enterpriseUrl: "company.ghe.com" });
  });
});

describe("authErrorMessage", () => {
  it("reads the message from an SDK error body", () => {
    expect(
      authErrorMessage({
        name: "ProviderAuthOauthCallbackFailed",
        data: { message: "Token exchange failed" },
      }),
    ).toBe("Token exchange failed");
  });

  it("hides OpenCode's generic server error placeholder", () => {
    expect(
      authErrorMessage({
        name: "UnknownError",
        data: { message: "Unexpected server error. Check server logs for details." },
      }),
    ).toBeUndefined();
  });

  it("falls back to the provider's response body when there is no message", () => {
    expect(
      authErrorMessage({
        name: "APIError",
        data: { message: "", responseBody: "Invalid API key." },
      }),
    ).toBe("Invalid API key.");
  });

  it("reads thrown Errors and ignores anything else", () => {
    expect(authErrorMessage(new Error("No client"))).toBe("No client");
    expect(authErrorMessage("rejected")).toBeUndefined();
    expect(authErrorMessage(undefined)).toBeUndefined();
  });
});

describe("deviceCode", () => {
  it("finds the code in OpenCode's instructions", () => {
    expect(deviceCode("Enter code: 2T75-15CTI")).toBe("2T75-15CTI");
    expect(deviceCode("Complete authorization in your browser.")).toBeNull();
    expect(deviceCode(null)).toBeNull();
  });
});

describe("oauthRecovery", () => {
  const options = authMethodOptions("openai", OPENAI_METHODS);

  it("steers a failed ChatGPT browser sign-in to the device code", () => {
    const recovery = oauthRecovery("openai", options[0], options);

    expect(recovery.suggestedIndex).toBe(1);
    expect(recovery.hint).toMatch(/Codex/);
  });

  it("gives other failures a generic next step", () => {
    expect(oauthRecovery("openai", options[1], options)).toEqual({
      hint: "Try again, or pick another way to connect.",
    });
  });
});

describe("connectHint", () => {
  it("tells ChatGPT subscribers that OpenAI is where their plan goes", () => {
    expect(connectHint("openai", OPENAI_METHODS)).toMatch(/ChatGPT/);
  });

  it("describes providers from their methods", () => {
    expect(connectHint("groq", [{ type: "api", label: "API key" }])).toBe("API key");
    expect(
      connectHint("gitlab", [
        { type: "oauth", label: "GitLab OAuth" },
        { type: "api", label: "Token" },
      ]),
    ).toBe("Sign in or use an API key");
    expect(connectHint("poe", [{ type: "oauth", label: "Poe" }])).toBe("Sign in with your account");
  });
});

describe("providerDisplayName", () => {
  it("calls OpenCode's built-in free tier Free models, not OpenCode Zen", () => {
    expect(providerDisplayName({ id: "opencode", name: "OpenCode Zen", source: "custom" })).toBe(
      "Free models",
    );
  });

  it("keeps the Zen name for a key from the environment or config", () => {
    for (const source of ["env", "config"]) {
      expect(providerDisplayName({ id: "opencode", name: "OpenCode Zen", source })).toBe(
        "OpenCode Zen",
      );
    }
  });

  it("uses the real name once a Zen key is added, and for every other provider", () => {
    expect(providerDisplayName({ id: "opencode", name: "OpenCode Zen", source: "api" })).toBe(
      "OpenCode Zen",
    );
    expect(providerDisplayName({ id: "openai", name: "OpenAI", source: "api" })).toBe("OpenAI");
  });
});
