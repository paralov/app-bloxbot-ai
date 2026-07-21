import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { describe, expect, it } from "vitest";

import { getOpenCodeUsageAction } from "@/lib/usageLimit";

function retryStatus(provider: string, reason: string): SessionStatus {
  return {
    type: "retry",
    attempt: 1,
    message: "Retrying",
    next: Date.now() + 60_000,
    action: {
      provider,
      reason,
      title: "Free limit reached",
      message: "Subscribe to OpenCode Go for reliable access.",
      label: "Subscribe",
      link: "https://opencode.ai/go",
    },
  };
}

describe("OpenCode usage actions", () => {
  it("uses OpenCode's structured free-tier action", () => {
    expect(getOpenCodeUsageAction(retryStatus("opencode", "free_tier_limit"))).toMatchObject({
      provider: "opencode",
      reason: "free_tier_limit",
      title: "Free limit reached",
    });
  });

  it("uses OpenCode Go account-limit actions", () => {
    expect(getOpenCodeUsageAction(retryStatus("opencode-go", "account_rate_limit"))).not.toBeNull();
  });

  it("ignores unstructured and third-party retry statuses", () => {
    expect(getOpenCodeUsageAction(retryStatus("anthropic", "free_tier_limit"))).toBeNull();
    expect(getOpenCodeUsageAction(retryStatus("opencode", "rate_limit"))).toBeNull();
    expect(getOpenCodeUsageAction({ type: "busy" })).toBeNull();
  });
});
