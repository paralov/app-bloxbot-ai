import { describe, expect, it } from "vitest";
import { freeLimitEndsAt, isFreeUsageLimit, presentModelError } from "@/lib/modelError";
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

  it("explains the limit and when it resets instead of showing the provider's error", () => {
    const presentation = presentModelError(
      limit({
        message: "Free usage limit reached. Subscribe to OpenCode Go to keep going.",
        retryAfterMs: 3 * 60 * 60 * 1000,
      }),
    );

    expect(presentation.kind).toBe("usage");
    expect(presentation.title).toBe("You've used today's free messages");
    expect(presentation.description).toContain("They reset in about 3 hours.");
    expect(presentation.description).toContain("OpenCode Go");
  });

  it("recognises the typed error in the response body", () => {
    expect(
      isFreeUsageLimit(limit({ responseBody: '{"error":{"type":"FreeUsageLimitError"}}' })),
    ).toBe(true);
    expect(isFreeUsageLimit(limit({ message: "Rate limit exceeded" }))).toBe(false);
  });

  it("counts a free limit down from when it hit, not from the saved text", () => {
    const hour = 60 * 60 * 1000;
    const hit = limit({ message: "Free usage limit reached.", retryAfterMs: 10 * hour });
    expect(presentModelError(hit, 0, 8 * hour).description).toContain("about 2 hours");
    expect(freeLimitEndsAt(hit, 0)).toBe(10 * hour);
  });
});
