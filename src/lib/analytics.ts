import type { PostHogInterface, Properties } from "posthog-js";
// The same bundle main.tsx initializes; the package root resolves to a separate instance.
import posthog from "posthog-js/dist/module.full.no-external.js";
import { AiTracer, type StudioAnalyticsContext } from "@/lib/aiTracing";

export const POSTHOG_PROJECT_TOKEN = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

let detailedAnalyticsEnabled = false;

export const ANALYTICS_SCHEMA_VERSION = 1;

// Bump when the analytics policy changes enough that users must be re-notified.
// Version 1 introduced opt-out model usage metrics with anonymized collection.
// Version 2 added prompts, responses, tool calls, and Roblox place IDs (AI traces).
export const ANALYTICS_NOTICE_VERSION = 2;

export function setDetailedAnalyticsEnabled(enabled: boolean): void {
  detailedAnalyticsEnabled = enabled;
  posthog.register({ analytics_detail_enabled: enabled });
  if (!enabled) aiTracer.reset();
}

/** The anonymous device identifier users quote in privacy requests; null when analytics is off. */
export function analyticsDeviceId(): string | null {
  try {
    return posthog.__loaded ? posthog.get_distinct_id() : null;
  } catch {
    return null;
  }
}

export function analyticsProperties(feature: string, properties: Properties = {}): Properties {
  return {
    analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
    feature,
    ...properties,
  };
}

export function errorAnalyticsProperties(
  feature: string,
  phase: string,
  error: unknown,
  properties: Properties = {},
): Properties {
  return analyticsProperties(feature, {
    outcome: "failure",
    phase,
    error_type: error instanceof Error ? error.name : typeof error,
    ...properties,
  });
}

export function detailedAnalyticsProperties(properties: Properties): Properties {
  return detailedAnalyticsEnabled ? properties : {};
}

export function captureDetailedAnalytics(
  posthog: PostHogInterface,
  event: string,
  properties: Properties,
): void {
  if (detailedAnalyticsEnabled) {
    posthog.capture(event, analyticsProperties("model", properties));
  }
}

const EXPLORER_ANALYTICS_KEYS = new Set([
  "class_category",
  "duration_ms",
  "has_attributes",
  "model_mediated",
  "node_count",
  "reason",
  "root_count",
  "source",
]);

let studioAnalyticsContext: StudioAnalyticsContext | null = null;

export function setStudioAnalyticsContext(context: StudioAnalyticsContext | null): void {
  studioAnalyticsContext = context;
}

/** PostHog LLM analytics traces; captured only while model usage metrics are on. */
export const aiTracer = new AiTracer(
  (event, properties) => {
    if (detailedAnalyticsEnabled) posthog.capture(event, analyticsProperties("ai", properties));
  },
  () => studioAnalyticsContext,
  Date.now,
  () => detailedAnalyticsEnabled,
);

export function explorerAnalyticsProperties(properties: Properties): Properties {
  return Object.fromEntries(
    Object.entries(properties).filter(
      ([key, value]) =>
        EXPLORER_ANALYTICS_KEYS.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  );
}

export function countBucket(count: number): "1" | "2-5" | "6-10" | "11+" {
  if (count <= 1) return "1";
  if (count <= 5) return "2-5";
  if (count <= 10) return "6-10";
  return "11+";
}
