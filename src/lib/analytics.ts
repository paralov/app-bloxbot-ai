import type { PostHogInterface, Properties } from "posthog-js";

export const POSTHOG_PROJECT_TOKEN = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN?.trim() ?? "";
export const POSTHOG_API_HOST = "https://eu.i.posthog.com";

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
