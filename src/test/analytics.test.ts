import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
  createPostHogOptions,
  detailedAnalyticsProperties,
  POSTHOG_API_HOST,
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

  it("enables basic production analytics while disabling automatic collection", async () => {
    const posthog = posthogStub();
    const options = createPostHogOptions({
      production: true,
      getVersion: async () => "0.6.0",
      platform: "MacIntel",
      runtime: "electron",
    });

    expect(options).toMatchObject({
      api_host: POSTHOG_API_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      advanced_disable_flags: true,
      opt_out_capturing_by_default: false,
      person_profiles: "never",
    });

    options.loaded?.(posthog as never);
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalled());

    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith("app_opened", { app_version: "0.6.0" });
  });

  it("forces development builds to remain opted out", () => {
    const posthog = posthogStub();
    const options = createPostHogOptions({
      production: false,
      getVersion: async () => "0.6.0",
      platform: "MacIntel",
      runtime: "browser",
    });

    options.loaded?.(posthog as never);

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

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
