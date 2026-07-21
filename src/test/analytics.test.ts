import { describe, expect, it, vi } from "vitest";
import {
  createPostHogOptions,
  disableAnalytics,
  enableAnalytics,
  POSTHOG_API_HOST,
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
  it("starts opted out with automatic and identifying collection disabled", () => {
    expect(createPostHogOptions()).toMatchObject({
      api_host: POSTHOG_API_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_product_tours: true,
      advanced_disable_flags: true,
      opt_out_capturing_by_default: true,
      person_profiles: "never",
      persistence: "localStorage",
      save_campaign_params: false,
      save_referrer: false,
    });
  });

  it("does not enable collection from development builds", async () => {
    const posthog = posthogStub();
    const getVersion = vi.fn(async () => "0.6.0");

    await enableAnalytics(posthog as never, {
      production: false,
      getVersion,
      platform: "MacIntel",
      runtime: "browser",
    });

    expect(getVersion).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("enables anonymous collection only after production consent", async () => {
    const posthog = posthogStub();

    await enableAnalytics(posthog as never, {
      production: true,
      getVersion: async () => "0.6.0",
      platform: "MacIntel",
      runtime: "electron",
    });

    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
    expect(posthog.register).toHaveBeenNthCalledWith(1, {
      app: "bloxbot",
      app_platform: "MacIntel",
      app_runtime: "electron",
    });
    expect(posthog.register).toHaveBeenNthCalledWith(2, { app_version: "0.6.0" });
    expect(posthog.capture).toHaveBeenCalledWith("app_opened", { app_version: "0.6.0" });
  });

  it("opts out immediately when consent is disabled", () => {
    const posthog = posthogStub();

    disableAnalytics(posthog as never);

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  });

  it("can opt back in without duplicating the app-open event", async () => {
    const posthog = posthogStub();
    const getVersion = vi.fn(async () => "0.6.0");

    await enableAnalytics(
      posthog as never,
      {
        production: true,
        getVersion,
        platform: "MacIntel",
        runtime: "electron",
      },
      false,
    );

    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
    expect(getVersion).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
