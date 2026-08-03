# Telemetry

BloxBot collects anonymous usage data and crash reports **by default** in
official builds, following the same practice as VS Code and Zed. On first
launch a notice tells the user what is collected and offers a one-click
opt-out. The choice persists and can be changed at any time in
Settings > Privacy.

## Controls

| Category | Default | Disable methods |
|---|---|---|
| **Usage analytics** (PostHog) | On | First-run notice, Settings > Privacy toggle, `DO_NOT_TRACK=1` |
| **Crash reports** (PostHog Error Tracking) | On | First-run notice, Settings > Privacy toggle, `DO_NOT_TRACK=1` |
| **Update checks** (electron-updater) | On in packaged builds | `BLOXBOT_DISABLE_AUTOUPDATE=1` |

## Two toggles

Usage analytics and crash reports are controlled independently. Each has its
own toggle in Settings > Privacy. Turning off both prevents PostHog from
initializing entirely.

## First-run notice

On the very first launch (`telemetryNoticeShown: false` in config), BloxBot
shows a notice explaining what is collected. The user can accept (both toggles
stay on, PostHog initializes) or turn off telemetry (both toggles go to off,
PostHog never initializes). Either choice sets `telemetryNoticeShown: true` so
the notice does not reappear.

## DO_NOT_TRACK

When the `DO_NOT_TRACK` environment variable is set to `1` or `true`, all
telemetry is suppressed: PostHog is never initialized, both toggles are forced
off, and the first-run notice is skipped. The toggles in Settings > Privacy
appear disabled.

## Event inventory

| Event | Properties |
|---|---|
| `app_opened` | `app_version` |
| `$pageview` | `$current_url`, `$host`, `$pathname`, `app_screen` |
| `$exception` | (PostHog Error Tracking built-in) |
| `session_created` | `outcome` |
| `message_sent` | `outcome`, `has_attachments`, `attachment_count`, `token_count_bucket` |
| `session_snoozed` | `outcome` |
| `session_unsnoozed` | `outcome` |
| `permanent_delete_requested` | (none beyond standard) |
| `session_permanently_deleted` | `outcome` |
| `snoozed_session_opened` | (none beyond standard) |
| `model_usage` | `provider`, `model`, `tokens_total`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_write`, `tokens_reasoning` |
| `update_available` | `update_version`, `current_version`, `is_patch` |
| `update_auto_installed` | `update_version` |
| `playtest_opened` | (none beyond standard) |
| `playtest_closed` | (none beyond standard) |
| `manual_entry_selected` | (none beyond standard) |
| `playtest_started` | `outcome`, `mode` |
| `playtest_stopped` | `reason` |
| `playtest_error` | (none beyond standard) |
| `sync_started` | `source` |
| `sync_completed` | `source`, `duration_ms`, `node_count`, `root_count` |
| `sync_error` | `error_type`, `phase` |
| `explorer_class_selected` | `class_category`, `has_attributes` |
| `explorer_node_toggled` | `class_category`, `model_mediated` |
| `explorer_copy_path` | (none beyond standard) |
| `prompt_template_selected` | `prompt_key` |
| `prompt_template_cancelled` | (none beyond standard) |
| `studio_target_selected` | (none beyond standard) |
| `studio_target_selection_error` | `error_type`, `phase` |
| `studio_connection_started` | `outcome` |
| `studio_connection_check_started` | (none beyond standard) |
| `studio_connection_check_completed` | `outcome` |
| `studio_connection_completed` | `outcome` |
| `studio_connection_skipped` | (none beyond standard) |
| `studio_target_picker_opened` | (none beyond standard) |
| `oauth_started` | `provider_id`, `outcome` |
| `provider_api_key_set` | `provider_id`, `outcome` |
| `provider_disconnected` | `provider_id`, `outcome` |

All events carry standard super-properties: `analytics_schema_version`,
`feature`, `app`, `app_version`, `app_platform`, `app_runtime`,
`app_user_agent`, `analytics_detail_enabled`.

## Property policy

All properties are metadata only: counts, durations, booleans, versions, model
identifiers, and outcome flags. **Never collected**: message content, prompts,
responses, file contents, file paths, code, or agent names.

## Anonymous-ID policy

PostHog is initialized with `person_profiles: "identified_only"`.
`posthog.identify()` is never called. Each device gets an anonymous distinct ID
that cannot be linked to a person without explicit identification (which BloxBot
does not perform).

## Update checks

Update checks are independent of PostHog. They only run in packaged
(installed) builds (`app.isPackaged`) and are inactive during development.
To disable them in a packaged build, set `BLOXBOT_DISABLE_AUTOUPDATE=1`.

## Self-built binaries

When you build BloxBot from source without setting `VITE_POSTHOG_PROJECT_TOKEN`,
PostHog is completely inert: the SDK is never initialized, and no analytics or
error-tracking network requests are made.
