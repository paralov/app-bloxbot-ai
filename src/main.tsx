import { PostHogProvider } from "@posthog/react";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { createPostHogOptions, POSTHOG_API_KEY } from "./lib/analytics";

const postHogOptions = createPostHogOptions();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <PostHogProvider apiKey={POSTHOG_API_KEY} options={postHogOptions}>
      <App />
    </PostHogProvider>
  </React.StrictMode>,
);
