import { describe, expect, it } from "vitest";

import { shouldRecommendOpenCodeGo } from "@/lib/opencodeGo";
import { connectHint } from "@/lib/providerAuth";

describe("shouldRecommendOpenCodeGo", () => {
  it("recommends Go to people on the free models only", () => {
    expect(shouldRecommendOpenCodeGo([])).toBe(true);
    expect(shouldRecommendOpenCodeGo(["opencode"])).toBe(true);
  });

  it("stays out of the way once another provider is connected", () => {
    expect(shouldRecommendOpenCodeGo(["opencode", "opencode-go"])).toBe(false);
    expect(shouldRecommendOpenCodeGo(["opencode", "openai"])).toBe(false);
  });
});

describe("OpenCode Go hint", () => {
  it("says it is a subscription and what it costs", () => {
    expect(connectHint("opencode-go", [])).toMatch(/Subscription.*\$10\/month/);
  });
});
