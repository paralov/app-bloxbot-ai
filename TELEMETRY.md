# Telemetry

BloxBot collects usage analytics **by default** in official builds. This
intentionally exceeds OpenCode's opt-in posture as a product decision: richer
default telemetry helps the team understand how the app is used and where it
fails.

| Category | Default | Disable method |
|---|---|---|
| **Usage analytics** (PostHog) | On in official builds (`VITE_POSTHOG_PROJECT_TOKEN`). Detailed analytics (provider, model, token counts) are on by default and can be turned off in Settings. | Omit the token at build time, or toggle off in Settings > Privacy. |
| **Error reporting** (PostHog Error Tracking) | On in official builds (`VITE_POSTHOG_PROJECT_TOKEN`). Baseline telemetry, not affected by the detailed-analytics toggle. | Omit the token at build time. |
| **Update checks** (electron-updater) | On in packaged builds (`app.isPackaged`). Independent of the PostHog token. | `BLOXBOT_DISABLE_AUTOUPDATE=1` |

## What is collected

### Event categories

- **App lifecycle**: app opened (with version).
- **Session lifecycle**: session created, message sent, session archived/unarchived/deleted.
- **Model usage** (detailed): provider, model name, aggregate token counts per response.
- **Feature usage**: explorer interactions, playtest runs, prompt templates, studio target connections.
- **Update lifecycle**: update available, auto-installed (with version, patch flag).
- **Preferences**: analytics preference changed (with enabled/disabled flag).
- **Errors**: error type and phase (never the error message itself); unhandled exceptions via PostHog Error Tracking.

### Property policy

All properties are metadata only: counts, durations, booleans, versions, model
identifiers, and outcome flags. **Never collected**: message content, prompts,
file contents, file paths, code, or agent names.

### Detailed-analytics opt-out

The in-app Settings > Privacy toggle controls whether detailed fields (provider
name, model name, token counts) are included. When turned off, only coarse
feature-usage events are sent. The preference persists across sessions. New
installs default to on; users who previously opted out remain opted out.

## Self-built binaries

When you build BloxBot from source without setting `VITE_POSTHOG_PROJECT_TOKEN`,
PostHog is completely inert: the SDK is never initialised, and no analytics or
error-tracking network requests are made.

Update checks are independent of the PostHog token. They only run in packaged
(installed) builds (`app.isPackaged`), so they are inactive during development.
To disable them in a packaged build, set `BLOXBOT_DISABLE_AUTOUPDATE=1`.
