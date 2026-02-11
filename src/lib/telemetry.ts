/** Product telemetry via PostHog (Rust-side, via tauri-plugin-posthog). */

import { invoke } from "@tauri-apps/api/core";

/**
 * Capture a telemetry event.
 *
 * Events are sent from the Rust backend using posthog-rs,
 * completely bypassing the webview's network restrictions.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  // Fire-and-forget: we don't want telemetry failures to affect the app.
  invoke("plugin:posthog|capture", {
    request: {
      event,
      properties: properties ?? null,
      distinctId: null,
      groups: null,
      timestamp: null,
      anonymous: false,
    },
  }).catch((err) => {
    console.warn("[telemetry] capture failed:", err);
  });
}
