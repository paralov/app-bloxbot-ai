import { PostHogProvider } from "@posthog/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { createPostHogOptions, POSTHOG_API_KEY } from "./lib/analytics";
import { desktop } from "./lib/desktop";

const postHogOptions = createPostHogOptions({
  production: import.meta.env.PROD,
  getVersion: () => desktop.getVersion(),
  platform: navigator.platform,
  runtime: window.bloxbot ? "electron" : "browser",
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PostHogProvider apiKey={POSTHOG_API_KEY} options={postHogOptions}>
      <App />
    </PostHogProvider>
  </React.StrictMode>,
);
