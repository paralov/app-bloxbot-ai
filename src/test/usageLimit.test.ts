import { describe, expect, it } from "vitest";

import type { ModelError } from "@/lib/modelError";
import { freeLimitUsageAction } from "@/lib/usageLimit";

const apiError = (message: string) => ({ name: "APIError", data: { message } }) as ModelError;

describe("OpenCode usage actions", () => {
  it("offers OpenCode Go when the free limit ends a turn", () => {
    expect(freeLimitUsageAction(apiError("Free usage limit reached."))).toMatchObject({
      provider: "opencode",
      reason: "free_tier_limit",
      link: "https://opencode.ai/go",
    });
  });

  it("stays out of the way for other errors", () => {
    expect(freeLimitUsageAction(apiError("Rate limit exceeded"))).toBeNull();
    expect(freeLimitUsageAction(null)).toBeNull();
  });
});
