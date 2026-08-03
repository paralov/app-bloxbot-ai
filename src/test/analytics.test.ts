import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
  countBucket,
  detailedAnalyticsProperties,
  errorAnalyticsProperties,
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
  // Detailed analytics are now on by default. Each test that exercises the
  // disabled path must explicitly opt out.
  beforeEach(() => setDetailedAnalyticsEnabled(true));

  it("buckets counts without exposing exact larger values", () => {
    expect(countBucket(1)).toBe("1");
    expect(countBucket(2)).toBe("2-5");
    expect(countBucket(5)).toBe("2-5");
    expect(countBucket(6)).toBe("6-10");
    expect(countBucket(10)).toBe("6-10");
    expect(countBucket(42)).toBe("11+");
  });

  it("includes detailed properties by default", () => {
    const properties = { provider: "anthropic", model: "claude-sonnet-4" };

    expect(detailedAnalyticsProperties(properties)).toEqual(properties);
  });

  it("removes detailed properties after explicit opt-out", () => {
    const properties = { provider: "anthropic", model: "claude-sonnet-4" };

    setDetailedAnalyticsEnabled(false);
    expect(detailedAnalyticsProperties(properties)).toEqual({});

    setDetailedAnalyticsEnabled(true);
    expect(detailedAnalyticsProperties(properties)).toEqual(properties);
  });

  it("captures detailed token usage by default and stops after opt-out", () => {
    const posthog = posthogStub();
    const usage = { provider: "anthropic", model: "claude-sonnet-4", tokens_total: 42 };

    captureDetailedAnalytics(posthog as never, "model_usage", usage);

    expect(posthog.capture).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith("model_usage", {
      analytics_schema_version: 1,
      feature: "model",
      ...usage,
    });

    posthog.capture.mockClear();
    setDetailedAnalyticsEnabled(false);
    captureDetailedAnalytics(posthog as never, "model_usage", usage);
    expect(posthog.capture).not.toHaveBeenCalled();
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

  it("adds standard metadata without including error messages", () => {
    expect(errorAnalyticsProperties("explorer", "sync", new TypeError("private path"))).toEqual({
      analytics_schema_version: 1,
      error_type: "TypeError",
      feature: "explorer",
      outcome: "failure",
      phase: "sync",
    });
  });
});
