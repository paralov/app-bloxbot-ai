import type { AssistantMessage, Model } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import {
  checkFailure,
  checkModelChoice,
  checkModels,
  checkPreference,
  pickCheckModel,
} from "@/lib/providerCheck";

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

describe("checkModels", () => {
  const ids = (models: Model[]) => models.map((m) => m.id);

  it("lists only models that can hold a chat with tools, by name", () => {
    const provider = {
      models: {
        "chatgpt-image-latest": model("chatgpt-image-latest", 0, 0, "active", imageOnly),
        "allam-2-7b": model("allam-2-7b", 0, 0, "active", { toolcall: false }),
        "speech-in": model("speech-in", 0, 0, "active", {
          input: { ...chat.input, text: false, audio: true },
        }),
        old: model("old", 0, 0, "deprecated"),
        "gpt-5": model("gpt-5", 1.25, 10),
        "gpt-4.1": model("gpt-4.1", 2, 8),
      },
    };
    expect(ids(checkModels(provider))).toEqual(["gpt-4.1", "gpt-5"]);
  });

  it("puts alpha models after the others", () => {
    const provider = {
      models: {
        aardvark: model("aardvark", 0, 0, "alpha"),
        beta: model("beta", 1, 1, "beta"),
        zed: model("zed", 1, 1),
      },
    };
    expect(ids(checkModels(provider))).toEqual(["beta", "zed", "aardvark"]);
  });

  it("puts the user's selected model first, then the provider's default", () => {
    const provider = {
      models: {
        cheap: model("cheap", 0, 0),
        "gpt-5.6-terra-pro": model("gpt-5.6-terra-pro", 15, 120),
        standard: model("standard", 1, 5),
      },
    };
    expect(
      ids(checkModels(provider, { selected: "gpt-5.6-terra-pro", default: "standard" })),
    ).toEqual(["gpt-5.6-terra-pro", "standard", "cheap"]);
    expect(pickCheckModel(provider, { default: "standard" })?.id).toBe("standard");
  });

  it("passes over a selected or default model that can't chat or doesn't exist", () => {
    const provider = {
      models: {
        image: model("image", 0, 0, "active", imageOnly),
        old: model("old", 0, 0, "deprecated"),
        fine: model("fine", 2, 8),
      },
    };
    expect(pickCheckModel(provider, { selected: "image", default: "old" })?.id).toBe("fine");
    expect(pickCheckModel(provider, { selected: "missing" })?.id).toBe("fine");
  });

  it("returns nothing when no model can chat", () => {
    expect(pickCheckModel({ models: { old: model("old", 1, 1, "deprecated") } })).toBeUndefined();
    expect(
      pickCheckModel(
        { models: { image: model("image", 0, 0, "active", imageOnly) } },
        { selected: "image" },
      ),
    ).toBeUndefined();
    expect(pickCheckModel({ models: {} })).toBeUndefined();
  });
});

describe("checkPreference", () => {
  it("uses the selected chat model only when it's from this provider", () => {
    const defaults = { openrouter: "std" };
    expect(checkPreference("openrouter", "openrouter/org/picked", defaults)).toEqual({
      selected: "org/picked",
      default: "std",
    });
    expect(checkPreference("openrouter", "anthropic/claude-sonnet", defaults)).toEqual({
      selected: undefined,
      default: "std",
    });
    expect(checkPreference("openai", null, undefined)).toEqual({
      selected: undefined,
      default: undefined,
    });
  });
});

describe("checkModelChoice", () => {
  it("says whether the checked model is the selected one, the default, or another", () => {
    const preferred = { selected: "a", default: "b" };
    expect(checkModelChoice("a", preferred)).toBe("selected");
    expect(checkModelChoice("b", preferred)).toBe("default");
    expect(checkModelChoice("c", preferred)).toBe("other");
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
