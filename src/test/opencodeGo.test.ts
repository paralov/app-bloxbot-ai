import { describe, expect, it } from "vitest";

import { shouldRecommendOpenCodeGo } from "@/lib/opencodeGo";

describe("shouldRecommendOpenCodeGo", () => {
  const freeTier = { id: "opencode", source: "custom" };

  it("recommends Go to people on the free models only", () => {
    expect(shouldRecommendOpenCodeGo([])).toBe(true);
    expect(shouldRecommendOpenCodeGo([freeTier])).toBe(true);
  });

  it("stays out of the way once another provider is connected", () => {
    expect(shouldRecommendOpenCodeGo([freeTier, { id: "opencode-go", source: "api" }])).toBe(false);
    expect(shouldRecommendOpenCodeGo([freeTier, { id: "openai", source: "api" }])).toBe(false);
  });

  it("stays out of the way once Zen has a key, which keeps the same provider ID", () => {
    expect(shouldRecommendOpenCodeGo([{ id: "opencode", source: "api" }])).toBe(false);
    expect(shouldRecommendOpenCodeGo([{ id: "opencode", source: "env" }])).toBe(false);
  });
});
