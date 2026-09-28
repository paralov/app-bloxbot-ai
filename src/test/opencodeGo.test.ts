import { describe, expect, it } from "vitest";

import { shouldRecommendOpenCodeGo } from "@/lib/opencodeGo";
import { connectHint } from "@/lib/providerAuth";

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

describe("OpenCode Go hint", () => {
  it("says it is a subscription and what it costs", () => {
    expect(connectHint("opencode-go", [])).toMatch(/Subscription.*\$10\/month/);
  });
});
