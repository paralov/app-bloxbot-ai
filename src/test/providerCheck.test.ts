import type { AssistantMessage, Model } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import { checkFailure, pickCheckModel } from "@/lib/providerCheck";

type ModelError = NonNullable<AssistantMessage["error"]>;

function model(id: string, input: number, output: number, status: Model["status"] = "active") {
  return { id, name: id, status, cost: { input, output } } as Model;
}

describe("pickCheckModel", () => {
  it("picks the cheapest model so a check costs as little as possible", () => {
    const provider = {
      models: {
        big: model("big", 15, 75),
        small: model("small", 0.15, 0.6),
        mid: model("mid", 3, 15),
      },
    };
    expect(pickCheckModel(provider)?.id).toBe("small");
  });

  it("prefers free models and skips deprecated ones", () => {
    const provider = {
      models: {
        old: model("old", 0, 0, "deprecated"),
        free: model("free", 0, 0),
        paid: model("paid", 1, 2),
      },
    };
    expect(pickCheckModel(provider)?.id).toBe("free");
  });

  it("falls back to deprecated models when nothing else exists", () => {
    expect(pickCheckModel({ models: { old: model("old", 1, 1, "deprecated") } })?.id).toBe("old");
    expect(pickCheckModel({ models: {} })).toBeUndefined();
  });
});

describe("checkFailure", () => {
  it("flags a rejected key so the user is offered a reconnect", () => {
    const error: ModelError = {
      name: "APIError",
      data: { message: "Invalid API key.", statusCode: 401, isRetryable: false },
    };
    expect(checkFailure(error)).toEqual({
      ok: false,
      message: "Invalid API key.",
      keyRejected: true,
    });
  });

  it("treats auth errors as rejected credentials", () => {
    const error: ModelError = {
      name: "ProviderAuthError",
      data: { providerID: "openai", message: "Token expired" },
    };
    expect(checkFailure(error).keyRejected).toBe(true);
  });

  it("uses the provider's response body when the message is empty", () => {
    const error: ModelError = {
      name: "APIError",
      data: { message: "", statusCode: 400, isRetryable: false, responseBody: "model not found" },
    };
    expect(checkFailure(error).message).toBe("model not found");
  });

  it("reports other failures without blaming the key", () => {
    const error: ModelError = {
      name: "APIError",
      data: { message: "The usage limit has been reached", statusCode: 429, isRetryable: true },
    };
    expect(checkFailure(error)).toMatchObject({
      message: "The usage limit has been reached",
      keyRejected: false,
    });
  });
});
