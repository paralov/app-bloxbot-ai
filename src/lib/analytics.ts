import type { PostHogConfig, PostHogInterface } from "posthog-js";

export const POSTHOG_API_KEY = "phc_bOlMECnl02VBjOp2Y8PNOD36gSBmAuekirxhPKxjbEz";
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

interface AnalyticsEnvironment {
  production: boolean;
  getVersion: () => Promise<string>;
  platform: string;
  runtime: "browser" | "electron";
}

export async function enableAnalytics(
  posthog: PostHogInterface,
  { production, getVersion, platform, runtime }: AnalyticsEnvironment,
  captureAppOpened = true,
): Promise<void> {
  if (!production) return;

  posthog.opt_in_capturing();
  posthog.register({
    app: "bloxbot",
    app_platform: platform,
    app_runtime: runtime,
  });
  if (!captureAppOpened) return;

  const version = await getVersion().catch(() => "unknown");
  posthog.register({ app_version: version });
  posthog.capture("app_opened", { app_version: version });
}

export function disableAnalytics(posthog: PostHogInterface): void {
  posthog.opt_out_capturing();
}

export function createPostHogOptions(): Partial<PostHogConfig> {
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
    opt_out_capturing_by_default: true,
    opt_out_capturing_persistence_type: "localStorage",
    person_profiles: "never",
    persistence: "localStorage",
    save_campaign_params: false,
    save_referrer: false,
  };
}
