import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDetailedAnalytics,
  createPostHogOptions,
  detailedAnalyticsProperties,
  POSTHOG_API_HOST,
  sanitizePostHogEvent,
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
      userAgent: "BloxBot/0.6.0",
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
      opt_out_useragent_filter: true,
      opt_out_capturing_by_default: false,
      person_profiles: "never",
      disable_persistence: true,
      persistence: "memory",
    });

    options.loaded?.(posthog as never);
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalled());

    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
    expect(posthog.register).toHaveBeenCalledWith({
      app: "bloxbot",
      app_platform: "MacIntel",
      app_runtime: "electron",
      app_user_agent: "BloxBot/0.6.0",
    });
    expect(posthog.capture).toHaveBeenCalledWith("app_opened", { app_version: "0.6.0" });
  });

  it("forces development builds to remain opted out", () => {
    const posthog = posthogStub();
    const options = createPostHogOptions({
      production: false,
      getVersion: async () => "0.6.0",
      platform: "MacIntel",
      runtime: "browser",
      userAgent: "BloxBot/0.6.0",
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

  it("strips PostHog browser, URL, device, session, and profile enrichment", () => {
    setDetailedAnalyticsEnabled(true);
    const sanitized = sanitizePostHogEvent({
      uuid: "event-id",
      event: "message_sent",
      properties: {
        token: POSTHOG_API_HOST,
        distinct_id: "temporary-launch-id",
        app: "bloxbot",
        app_platform: "MacIntel",
        provider: "anthropic",
        model: "claude-sonnet-4",
        $current_url: "file:///Users/alice/Applications/BloxBot/index.html",
        $pathname: "/Users/alice/Applications/BloxBot/index.html",
        $user_agent: "secret-user-agent",
        $device_id: "persistent-device-id",
        $session_id: "session-id",
        $window_id: "window-id",
        $screen_width: 1920,
        timezone: "Europe/Oslo",
      },
      $set: { email: "alice@example.com" },
      $set_once: { name: "Alice" },
    });

    expect(sanitized).toEqual({
      uuid: "event-id",
      event: "message_sent",
      properties: {
        token: POSTHOG_API_HOST,
        distinct_id: "temporary-launch-id",
        app: "bloxbot",
        app_platform: "MacIntel",
        provider: "anthropic",
        model: "claude-sonnet-4",
        $geoip_disable: true,
      },
    });
  });

  it("enforces detailed consent again at the final outbound boundary", () => {
    expect(
      sanitizePostHogEvent({
        uuid: "event-id",
        event: "message_sent",
        properties: {
          token: POSTHOG_API_HOST,
          distinct_id: "temporary-launch-id",
          provider: "anthropic",
          model: "claude-sonnet-4",
        },
      }),
    ).toEqual({
      uuid: "event-id",
      event: "message_sent",
      properties: {
        token: POSTHOG_API_HOST,
        distinct_id: "temporary-launch-id",
        $geoip_disable: true,
      },
    });

    expect(
      sanitizePostHogEvent({
        uuid: "event-id",
        event: "model_usage",
        properties: { distinct_id: "temporary-launch-id", tokens_total: 42 },
      }),
    ).toBeNull();
  });

  it("drops any event that is not explicitly approved", () => {
    expect(
      sanitizePostHogEvent({
        uuid: "event-id",
        event: "$pageview",
        properties: { distinct_id: "temporary-launch-id" },
      }),
    ).toBeNull();
  });
});
