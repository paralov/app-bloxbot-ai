import type { CaptureResult, PostHogInterface, Properties } from "posthog-js";
// The same bundle main.tsx initializes; the package root resolves to a separate instance.
import posthog from "posthog-js/dist/module.full.no-external.js";
import { AiTracer, type StudioAnalyticsContext } from "@/lib/aiTracing";
import {
  createErrorDeduper,
  describeError,
  ERROR_STACK_MAX_LENGTH,
  errorFromMainReport,
  scrubErrorMessage,
  scrubEventProperties,
} from "@/lib/errorReporting";
import type { MainErrorReport } from "@/types/desktop";

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
  const { type, message } = describeError(error);
  return analyticsProperties(feature, {
    outcome: "failure",
    phase,
    error_type: type,
    // Scrubbed of paths, usernames and keys here and again in PostHog's before_send.
    ...(message ? { error_message: scrubErrorMessage(message) } : {}),
    ...properties,
  });
}

/** PostHog `before_send` hook: scrubs error text from every event before it leaves the device. */
export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  return { ...event, properties: scrubEventProperties(event.properties) };
}

/**
 * Reports an exception to PostHog error tracking. A no-op in development and whenever
 * PostHog isn't initialized; PostHog's own opt-out and `before_send` scrubbing still apply.
 */
export function reportException(error: unknown, properties: Properties = {}): void {
  try {
    if (!posthog.__loaded) return;
    posthog.captureException(error, properties);
  } catch {
    // Reporting must never be the thing that fails.
  }
}

/** Scrubs and shortens a React component stack for an error report. */
export function componentStackProperty(componentStack: string | null | undefined): string | null {
  return componentStack ? scrubErrorMessage(componentStack.trim(), 2000) : null;
}

const MAIN_ERROR_DEDUPE_MS = 60_000;

/** Reports errors forwarded from the Electron main process; returns an unsubscribe. */
export function subscribeToMainErrors(
  subscribe: (listener: (report: MainErrorReport) => void) => () => void,
): () => void {
  const shouldReport = createErrorDeduper(MAIN_ERROR_DEDUPE_MS);
  return subscribe((report) => {
    if (!shouldReport(`${report.source}\u0000${report.name}\u0000${report.message}`)) return;
    reportException(
      errorFromMainReport({
        ...report,
        message: scrubErrorMessage(report.message),
        stack: report.stack ? scrubErrorMessage(report.stack, ERROR_STACK_MAX_LENGTH) : undefined,
      }),
      { source: report.source, process: "main" },
    );
  });
}

export function detailedAnalyticsProperties(properties: Properties): Properties {
  return detailedAnalyticsEnabled ? properties : {};
}

/**
 * Replaces the given provider and model names in free text unless detailed
 * analytics is on, so an error message can't reveal which model someone uses.
 */
export function maskModelUsage(
  text: string,
  names: { provider?: string; models?: readonly (string | undefined)[] },
): string {
  if (detailedAnalyticsEnabled) return text;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const replaceAll = (input: string, name: string | undefined, label: string) =>
    name && name.length > 1 ? input.replace(new RegExp(escape(name), "gi"), label) : input;
  // Longest first, so a model id isn't half-replaced by a shorter name inside it.
  const models = [...(names.models ?? [])]
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => b.length - a.length);
  const masked = models.reduce((acc, name) => replaceAll(acc, name, "<model>"), text);
  return replaceAll(masked, names.provider, "<provider>");
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
  "program_sequence",
  "program_source",
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
