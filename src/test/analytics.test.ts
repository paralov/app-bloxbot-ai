import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
  detailedAnalyticsProperties,
  setDetailedAnalyticsEnabled,
} from "@/lib/analytics";

function posthogStub() {
  return {
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
    register: vi.fn(),
    capture: vi.fn(),
  };
}

describe("PostHog analytics", () => {
  beforeEach(() => setDetailedAnalyticsEnabled(false));

  it("removes detailed properties until the user opts in", () => {
    const properties = { provider: "anthropic", model: "claude-sonnet-4" };

    expect(detailedAnalyticsProperties(properties)).toEqual({});

    setDetailedAnalyticsEnabled(true);

    expect(detailedAnalyticsProperties(properties)).toEqual(properties);
  });

  it("captures detailed token usage only after opt-in", () => {
    const posthog = posthogStub();
    const usage = { provider: "anthropic", model: "claude-sonnet-4", tokens_total: 42 };

    captureDetailedAnalytics(posthog as never, "model_usage", usage);
    expect(posthog.capture).not.toHaveBeenCalled();

    setDetailedAnalyticsEnabled(true);
    captureDetailedAnalytics(posthog as never, "model_usage", usage);

    expect(posthog.capture).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith("model_usage", usage);
  });
});
