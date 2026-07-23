import posthog from "posthog-js/dist/module.full.no-external.js";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { POSTHOG_API_HOST, POSTHOG_PROJECT_TOKEN } from "./lib/analytics";
import { desktop } from "./lib/desktop";

if (import.meta.env.PROD && POSTHOG_PROJECT_TOKEN) {
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: POSTHOG_API_HOST,
    person_profiles: "always",
    // BloxBot intentionally contains "bot", which matches PostHog's bot heuristic.
    opt_out_useragent_filter: true,
  });
  posthog.register({
    app: "bloxbot",
    app_platform: navigator.platform,
    app_runtime: window.bloxbot ? "electron" : "browser",
    app_user_agent: navigator.userAgent,
  });
  void desktop.getVersion().then(
    (version) => {
      posthog.register({ app_version: version });
      posthog.capture("app_opened", { app_version: version });
    },
    () => posthog.capture("app_opened", { app_version: "unknown" }),
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
