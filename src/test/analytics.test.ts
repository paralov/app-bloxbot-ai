import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
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
  beforeEach(() => setDetailedAnalyticsEnabled(false));

  it("removes detailed properties while model usage metrics are off", () => {
    const properties = { provider: "anthropic", model: "claude-sonnet-4" };

    expect(detailedAnalyticsProperties(properties)).toEqual({});

    setDetailedAnalyticsEnabled(true);

    expect(detailedAnalyticsProperties(properties)).toEqual(properties);
  });

  it("captures detailed token usage only while model usage metrics are on", () => {
    const posthog = posthogStub();
    const usage = { provider: "anthropic", model: "claude-sonnet-4", tokens_total: 42 };

    captureDetailedAnalytics(posthog as never, "model_usage", usage);
    expect(posthog.capture).not.toHaveBeenCalled();

    setDetailedAnalyticsEnabled(true);
    captureDetailedAnalytics(posthog as never, "model_usage", usage);

    expect(posthog.capture).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith("model_usage", {
      analytics_schema_version: 1,
      feature: "model",
      ...usage,
    });
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

  it("adds standard metadata with a scrubbed error message", () => {
    expect(
      errorAnalyticsProperties(
        "explorer",
        "sync",
        new TypeError("cannot open /Users/oscar/BloxBot/place.rbxl"),
      ),
    ).toEqual({
      analytics_schema_version: 1,
      error_message: "cannot open ~/BloxBot/place.rbxl",
      error_type: "TypeError",
      feature: "explorer",
      outcome: "failure",
      phase: "sync",
    });
  });

  it("truncates long error messages and omits missing ones", () => {
    const properties = errorAnalyticsProperties(
      "chat",
      "send_message",
      new Error("x".repeat(5000)),
    );
    expect((properties.error_message as string).length).toBe(500);
    expect(errorAnalyticsProperties("chat", "send_message", undefined)).not.toHaveProperty(
      "error_message",
    );
  });
});
