import posthog from "posthog-js/dist/module.full.no-external.js";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { createPostHogOptions, POSTHOG_PROJECT_TOKEN } from "./lib/analytics";
import { desktop } from "./lib/desktop";

const postHogOptions = createPostHogOptions({
  production: import.meta.env.PROD,
  getVersion: () => desktop.getVersion(),
  platform: navigator.platform,
  runtime: window.bloxbot ? "electron" : "browser",
});

if (POSTHOG_PROJECT_TOKEN) posthog.init(POSTHOG_PROJECT_TOKEN, postHogOptions);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
