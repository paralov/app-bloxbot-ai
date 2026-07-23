import type { CaptureResult, PostHogConfig, PostHogInterface, Properties } from "posthog-js";

export const POSTHOG_PROJECT_TOKEN = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

interface AnalyticsEnvironment {
  production: boolean;
  getVersion: () => Promise<string>;
  platform: string;
  runtime: "browser" | "electron";
}

let detailedAnalyticsEnabled = false;

const COMMON_ANALYTICS_PROPERTIES = [
  "token",
  "distinct_id",
  "$lib",
  "$lib_version",
  "$config_defaults",
  "$process_person_profile",
  "app",
  "app_platform",
  "app_runtime",
  "app_version",
] as const;

const EVENT_ANALYTICS_PROPERTIES = new Map<string, readonly string[]>([
  ["app_opened", ["app_version"]],
  ["session_created", []],
  ["message_sent", ["provider", "model"]],
  ["provider_connected", ["method", "provider"]],
  ["provider_disconnected", ["provider"]],
  [
    "model_usage",
    [
      "provider",
      "model",
      "tokens_total",
      "tokens_input",
      "tokens_output",
      "tokens_reasoning",
      "tokens_cache_read",
      "tokens_cache_write",
    ],
  ],
]);

const DETAILED_ANALYTICS_PROPERTIES = new Set([
  "provider",
  "model",
  "tokens_total",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
]);

const DETAILED_ANALYTICS_EVENTS = new Set(["model_usage"]);

/**
 * Final outbound privacy boundary. PostHog enriches manual events with browser,
 * URL, device, and session properties, so only explicitly approved fields may
 * leave the app.
 */
export function sanitizePostHogEvent(capture: CaptureResult | null): CaptureResult | null {
  if (!capture) return null;
  const eventProperties = EVENT_ANALYTICS_PROPERTIES.get(capture.event);
  if (!eventProperties) return null;
  if (!detailedAnalyticsEnabled && DETAILED_ANALYTICS_EVENTS.has(capture.event)) return null;

  const allowed = new Set([...COMMON_ANALYTICS_PROPERTIES, ...eventProperties]);
  const properties = Object.fromEntries(
    Object.entries(capture.properties).filter(
      ([key]) =>
        allowed.has(key) && (detailedAnalyticsEnabled || !DETAILED_ANALYTICS_PROPERTIES.has(key)),
    ),
  );

  // Prevent PostHog from deriving location from the request IP address.
  properties.$geoip_disable = true;

  const { $set: _set, $set_once: _setOnce, ...eventWithoutProfiles } = capture;
  return { ...eventWithoutProfiles, properties };
}

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
    disable_persistence: true,
    persistence: "memory",
    save_campaign_params: false,
    save_referrer: false,
    before_send: sanitizePostHogEvent,
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
