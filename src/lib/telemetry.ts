/** Product telemetry via PostHog. */

import posthog from "posthog-js";

const POSTHOG_KEY = "phc_4LeGCHJx8ymSSCZd3hf5QK8nlq3Sf1ZSC8nyRLc2JY4";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let initialized = false;

/** Initialize PostHog. Call once at app startup. */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
  });
}

/** Capture a telemetry event. No-op if called before init. */
export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}
