import type { Message, Part } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";
import { buildPlaytestHistory, formatPlaytestPrompt, parsePlaytestPlan } from "@/lib/playtestPlan";

describe("playtest plan helpers", () => {
  it("validates and normalizes a complete plan", () => {
    expect(
      parsePlaytestPlan({
        goal: " Test combat ",
        steps: [" Join arena "],
        watchFor: ["Lag"],
        successCriteria: ["No errors"],
      }),
    ).toEqual({
      goal: "Test combat",
      steps: ["Join arena"],
      watchFor: ["Lag"],
      successCriteria: ["No errors"],
    });
  });

  it("rejects incomplete structured output", () => {
    expect(() => parsePlaytestPlan({ goal: "Test", steps: [] })).toThrow("incomplete");
  });

  it("includes text-only chat context and formats a normal agent prompt", () => {
    const history = buildPlaytestHistory([
      {
        info: { role: "user" } as Message,
        parts: [{ type: "text", text: "Build a shop" } as Part],
      },
      {
        info: { role: "assistant" } as Message,
        parts: [{ type: "text", text: "Shop built" } as Part],
      },
    ]);
    expect(history).toContain("User: Build a shop");
    const prompt = formatPlaytestPrompt({
      goal: "Verify shop",
      steps: ["Buy item"],
      watchFor: ["Errors"],
      successCriteria: ["Item granted"],
    });
    expect(prompt).toContain(
      "Run this playtest in the currently connected Roblox Studio experience",
    );
    expect(prompt).toContain("1. Buy item");
  });
});
