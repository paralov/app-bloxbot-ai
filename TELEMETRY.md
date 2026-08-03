# Telemetry

BloxBot includes three categories of outbound communication.

| Category | What is sent | Default | How to disable |
|---|---|---|---|
| **Usage analytics** (PostHog) | Anonymous product-usage events (screens viewed, features used, error types). Detailed model analytics (provider, model name, token counts) are sent only after the user opts in via Settings. | Active in official builds when `VITE_POSTHOG_PROJECT_TOKEN` is set. | Omit the token at build time, or remove the PostHog init block in `src/main.tsx`. |
| **Error reporting** (PostHog Error Tracking) | Unhandled exceptions with stack traces. Sent to the same PostHog project (`eu.i.posthog.com`) as usage analytics. No additional vendor or token is required. Error reporting is baseline telemetry and is not gated behind the detailed-analytics opt-in. | Active in official builds when `VITE_POSTHOG_PROJECT_TOKEN` is set. | Omit the token at build time. |
| **Update checks** (electron-updater) | An HTTPS request to the GitHub Releases API to check whether a newer version is available. No usage data is sent. | Active in packaged (installed) builds. | Set the environment variable `BLOXBOT_DISABLE_AUTOUPDATE=1` before launching the app. |

## Self-built binaries

When you build BloxBot from source without setting `VITE_POSTHOG_PROJECT_TOKEN`,
PostHog is completely inert: the SDK is never initialised, and no analytics or
error-tracking network requests are made.

Update checks are independent of the PostHog token. They only run in packaged
(installed) builds (`app.isPackaged`), so they are inactive during development.
To disable them in a packaged build, set `BLOXBOT_DISABLE_AUTOUPDATE=1`.
