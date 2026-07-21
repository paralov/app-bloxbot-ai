import type { PostHogConfig, PostHogInterface, Properties } from "posthog-js";

export const POSTHOG_API_KEY = "phc_bOlMECnl02VBjOp2Y8PNOD36gSBmAuekirxhPKxjbEz";
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

interface AnalyticsEnvironment {
  production: boolean;
  getVersion: () => Promise<string>;
  platform: string;
  runtime: "browser" | "electron";
}

let detailedAnalyticsEnabled = false;

export function setDetailedAnalyticsEnabled(enabled: boolean): void {
  detailedAnalyticsEnabled = enabled;
}

export function detailedAnalyticsProperties(properties: Properties): Properties {
  return detailedAnalyticsEnabled ? properties : {};
}

export function captureDetailedAnalytics(
  posthog: PostHogInterface,
  event: string,
  properties: Properties,
): void {
  if (detailedAnalyticsEnabled) posthog.capture(event, properties);
}

export function createPostHogOptions({
  production,
  getVersion,
  platform,
  runtime,
}: AnalyticsEnvironment): Partial<PostHogConfig> {
  return {
    api_host: POSTHOG_API_HOST,
    defaults: "2026-01-30",
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    advanced_disable_flags: true,
    advanced_disable_toolbar_metrics: true,
    opt_out_capturing_by_default: !production,
    opt_out_capturing_persistence_type: "localStorage",
    person_profiles: "never",
    persistence: "localStorage",
    save_campaign_params: false,
    save_referrer: false,
    loaded: (posthog) => {
      if (!production) {
        posthog.opt_out_capturing();
        return;
      }

      posthog.opt_in_capturing();
      posthog.register({
        app: "bloxbot",
        app_platform: platform,
        app_runtime: runtime,
      });
      void getVersion().then(
        (version) => {
          posthog.register({ app_version: version });
          posthog.capture("app_opened", { app_version: version });
        },
        () => posthog.capture("app_opened", { app_version: "unknown" }),
      );
    },
  };
}
