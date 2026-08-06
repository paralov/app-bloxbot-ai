import posthog from "posthog-js/dist/module.full.no-external.js";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import {
  ANALYTICS_SCHEMA_VERSION,
  analyticsProperties,
  POSTHOG_API_HOST,
  POSTHOG_PROJECT_TOKEN,
} from "./lib/analytics";
import { desktop } from "./lib/desktop";

if (import.meta.env.PROD && POSTHOG_PROJECT_TOKEN) {
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: POSTHOG_API_HOST,
    // Anonymous events only: no identify() calls, so no person profile is created.
    // The persisted random device id remains the stable fingerprint.
    person_profiles: "identified_only",
    capture_pageview: false,
    autocapture: false,
    disable_session_recording: true,
    // BloxBot intentionally contains "bot", which matches PostHog's bot heuristic.
    opt_out_useragent_filter: true,
  });
  posthog.register({
    $current_url: "bloxbot://app/loading",
    $host: "app",
    $pathname: "/loading",
    // Skip server-side IP-based location enrichment.
    $geoip_disable: true,
    app: "bloxbot",
    analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
    analytics_detail_enabled: false,
    app_platform: navigator.platform,
    app_runtime: window.bloxbot ? "electron" : "browser",
    app_screen: "loading",
  });
  void desktop.getVersion().then(
    (version) => {
      posthog.register({ app_version: version });
      posthog.capture("app_opened", analyticsProperties("app", { app_version: version }));
    },
    () => posthog.capture("app_opened", analyticsProperties("app", { app_version: "unknown" })),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
