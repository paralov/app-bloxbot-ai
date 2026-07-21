import { describe, expect, it, vi } from "vitest";
import { createPostHogOptions, POSTHOG_API_HOST } from "@/lib/analytics";

function posthogStub() {
  return {
    register: vi.fn(),
    capture: vi.fn(),
  };
}

describe("PostHog analytics", () => {
  it("uses explicit, anonymous product analytics only", () => {
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
      person_profiles: "never",
      persistence: "localStorage",
      save_campaign_params: false,
      save_referrer: false,
    });
  });

  it("does not capture from development builds", async () => {
    const posthog = posthogStub();
    const getVersion = vi.fn(async () => "0.6.0");
    const options = createPostHogOptions({
      production: false,
      getVersion,
      platform: "MacIntel",
      runtime: "browser",
    });

    options.loaded?.(posthog as never);
    await Promise.resolve();

    expect(options.opt_out_capturing_by_default).toBe(true);
    expect(getVersion).not.toHaveBeenCalled();
    expect(posthog.register).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("captures a production app-open health event with safe app properties", async () => {
    const posthog = posthogStub();
    const options = createPostHogOptions({
      production: true,
      getVersion: async () => "0.6.0",
      platform: "MacIntel",
      runtime: "electron",
    });

    options.loaded?.(posthog as never);
    await vi.waitFor(() => expect(posthog.capture).toHaveBeenCalled());

    expect(posthog.register).toHaveBeenNthCalledWith(1, {
      app: "bloxbot",
      app_platform: "MacIntel",
      app_runtime: "electron",
    });
    expect(posthog.register).toHaveBeenNthCalledWith(2, { app_version: "0.6.0" });
    expect(posthog.capture).toHaveBeenCalledWith("app_opened", { app_version: "0.6.0" });
  });
});
