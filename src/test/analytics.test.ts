import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
  detailedAnalyticsProperties,
  explorerAnalyticsProperties,
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

  it("keeps Explorer analytics coarse and strips object content", () => {
    expect(
      explorerAnalyticsProperties({
        duration_ms: 42,
        node_count: 8,
        source: "initial",
        class_category: "known",
        path: "game.Workspace.Secret",
        name: "Secret",
        placeName: "Private place",
        properties: "Position=1,2,3",
        attributes: "Owner=Oscar",
      }),
    ).toEqual({
      duration_ms: 42,
      node_count: 8,
      source: "initial",
      class_category: "known",
    });
  });
});
