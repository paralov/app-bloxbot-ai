import type { AssistantMessage } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import { presentModelError } from "@/lib/modelError";

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
