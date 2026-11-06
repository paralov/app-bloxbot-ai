import { describe, expect, it } from "vitest";
import {
  FREE_LIMIT_FALLBACK_MS,
  freeLimitEndsAt,
  isFreeUsageLimit,
  isModelUnavailable,
  isRegionLocked,
  presentModelError,
} from "@/lib/modelError";
import type { AssistantMessage } from "@/lib/opencode/types";

type ModelError = NonNullable<AssistantMessage["error"]>;

describe("model error presentation", () => {
  it("does not infer error categories from provider message text", () => {
    const error: ModelError = {
      name: "APIError",
      data: {
        message: "You exceeded your current quota",
        statusCode: 429,
        isRetryable: false,
      },
    };

    expect(presentModelError(error)).toMatchObject({
      kind: "generic",
      title: "The model could not respond",
    });
  });

  it("gives context overflow errors a specific recovery path", () => {
    const error: ModelError = {
      name: "ContextOverflowError",
      data: { message: "Input exceeds the context window" },
    };

    expect(presentModelError(error)).toMatchObject({
      kind: "context",
      title: "This conversation is too large",
    });
  });
});

describe("free usage limit", () => {
  const limit = (data: Record<string, unknown>) => ({ name: "APIError", data }) as ModelError;
  const hour = 60 * 60 * 1000;
  // What a chat turn gets from OpenCode 2.2.5, and what its helper prompts get.
  const chatTurn = limit({
    message:
      "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
    statusCode: 429,
    responseBody: '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
    retryAfterMs: 3 * hour,
    isRetryable: false,
  });
  const helperPrompt = {
    name: "UnknownError",
    data: {
      message:
        "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
      isRetryable: false,
    },
  } as ModelError;

  it("explains the limit and when the messages come back instead of showing the provider's error", () => {
    const presentation = presentModelError(chatTurn);

    expect(presentation.kind).toBe("usage");
    expect(presentation.title).toBe("You've used the free messages for now");
    expect(presentation.description).toContain("Free messages come back in about 3 hours.");
    expect(presentation.description).toContain("connect a provider in Settings");
    expect(presentation.description).toContain("OpenCode Go");
    // The limit is shared by every free model, whatever OpenCode's own text says.
    expect(presentation.description).not.toMatch(/switch models|other free models/i);
  });

  it("recognises both of OpenCode's messages, and the typed error", () => {
    expect(isFreeUsageLimit(chatTurn)).toBe(true);
    expect(isFreeUsageLimit(helperPrompt)).toBe(true);
    expect(
      isFreeUsageLimit(limit({ responseBody: '{"error":{"type":"FreeUsageLimitError"}}' })),
    ).toBe(true);
    expect(isFreeUsageLimit(limit({ message: "Busy", type: "provider.free-limit" }))).toBe(true);
    expect(isFreeUsageLimit(limit({ message: "Rate limit exceeded" }))).toBe(false);
  });

  it("says a few hours, not a day, when OpenCode gives no reset time", () => {
    const presentation = presentModelError(helperPrompt, 0, 0);
    expect(presentation.description).toContain("Free messages come back after a few hours.");
    expect(presentation.description).not.toMatch(/daily|today|tomorrow/i);
    expect(freeLimitEndsAt(helperPrompt, 0)).toBe(FREE_LIMIT_FALLBACK_MS);
    expect(FREE_LIMIT_FALLBACK_MS).toBe(3 * hour);
  });

  it("counts a free limit down from when it hit, not from the saved text", () => {
    const hit = limit({ message: "Free usage limit reached.", retryAfterMs: 10 * hour });
    expect(presentModelError(hit, 0, 8 * hour).description).toContain("about 2 hours");
    expect(presentModelError(hit, 0, 9.7 * hour).description).toContain("less than an hour");
    expect(freeLimitEndsAt(hit, 0)).toBe(10 * hour);
  });
});

describe("models that can't answer here", () => {
  const unknown = (message: string, responseBody?: string) =>
    ({ name: "UnknownError", data: { message, responseBody } }) as ModelError;

  it("tells a model refused in the user's region apart, wherever OpenCode puts the reason", () => {
    const inMessage = unknown("This model is not available in your country");
    const inBody = unknown(
      "Provider request failed",
      '{"error":{"message":"This model is not available in your country"}}',
    );
    for (const error of [inMessage, inBody]) {
      expect(isRegionLocked(error)).toBe(true);
      expect(presentModelError(error)).toMatchObject({
        kind: "region",
        title: "This model isn't offered in your region",
      });
    }
  });

  it("tells a retired model apart from other upstream failures", () => {
    const retired = unknown("Upstream request failed: Model is unavailable.");
    expect(isModelUnavailable(retired)).toBe(true);
    expect(presentModelError(retired)).toMatchObject({
      kind: "unavailable",
      title: "This model is no longer available",
    });
    expect(isModelUnavailable(unknown("Upstream request failed: Service is unavailable."))).toBe(
      false,
    );
    expect(isRegionLocked(retired)).toBe(false);
  });
});
