import type { AssistantMessage, Model } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import { checkFailure, pickCheckModel } from "@/lib/providerCheck";

type ModelError = NonNullable<AssistantMessage["error"]>;

const chat = {
  toolcall: true,
  input: { text: true, audio: false, image: false, video: false, pdf: false },
  output: { text: true, audio: false, image: false, video: false, pdf: false },
};

function model(
  id: string,
  input: number,
  output: number,
  status: Model["status"] = "active",
  capabilities: Partial<typeof chat> = {},
) {
  return {
    id,
    name: id,
    status,
    cost: { input, output },
    capabilities: { ...chat, ...capabilities },
  } as Model;
}

const imageOnly = { output: { ...chat.output, text: false, image: true } };

describe("pickCheckModel", () => {
  it("picks the cheapest chat model so a check costs as little as possible", () => {
    const provider = {
      models: {
        big: model("big", 15, 75),
        small: model("small", 0.15, 0.6),
        mid: model("mid", 3, 15),
      },
    };
    expect(pickCheckModel(provider)).toMatchObject({ model: { id: "small" }, choice: "cheapest" });
  });

  it("prefers free models and skips deprecated ones", () => {
    const provider = {
      models: {
        old: model("old", 0, 0, "deprecated"),
        free: model("free", 0, 0),
        paid: model("paid", 1, 2),
      },
    };
    expect(pickCheckModel(provider)?.model.id).toBe("free");
  });

  it("skips models that can't hold a chat with tools", () => {
    const provider = {
      models: {
        "chatgpt-image-latest": model("chatgpt-image-latest", 0, 0, "active", imageOnly),
        "allam-2-7b": model("allam-2-7b", 0, 0, "active", { toolcall: false }),
        "speech-in": model("speech-in", 0, 0, "active", {
          input: { ...chat.input, text: false, audio: true },
        }),
        "gpt-5": model("gpt-5", 1.25, 10),
      },
    };
    expect(pickCheckModel(provider)?.model.id).toBe("gpt-5");
  });

  it("prefers stable models over alpha ones, but uses alpha when that's all there is", () => {
    const alpha = model("alpha", 0, 0, "alpha");
    expect(pickCheckModel({ models: { alpha, beta: model("beta", 1, 1, "beta") } })?.model.id).toBe(
      "beta",
    );
    expect(pickCheckModel({ models: { alpha } })?.model.id).toBe("alpha");
  });

  it("uses the user's selected model first, then the provider's default", () => {
    const provider = {
      models: {
        cheap: model("cheap", 0, 0),
        chosen: model("chosen", 3, 15),
        standard: model("standard", 1, 5),
      },
    };
    expect(pickCheckModel(provider, { selected: "chosen", default: "standard" })).toMatchObject({
      model: { id: "chosen" },
      choice: "selected",
    });
    expect(pickCheckModel(provider, { default: "standard" })).toMatchObject({
      model: { id: "standard" },
      choice: "default",
    });
  });

  it("passes over a selected or default model that can't chat or doesn't exist", () => {
    const provider = {
      models: {
        image: model("image", 0, 0, "active", imageOnly),
        old: model("old", 0, 0, "deprecated"),
        fine: model("fine", 2, 8),
      },
    };
    expect(pickCheckModel(provider, { selected: "image", default: "fine" })).toMatchObject({
      model: { id: "fine" },
      choice: "default",
    });
    expect(pickCheckModel(provider, { selected: "missing", default: "old" })).toMatchObject({
      model: { id: "fine" },
      choice: "cheapest",
    });
  });

  it("returns nothing when no model can chat", () => {
    expect(pickCheckModel({ models: { old: model("old", 1, 1, "deprecated") } })).toBeUndefined();
    expect(
      pickCheckModel(
        { models: { image: model("image", 0, 0, "active", imageOnly) } },
        {
          selected: "image",
        },
      ),
    ).toBeUndefined();
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
