# Changelog

All notable changes to BloxBot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- BloxBot downloads signed updates to the small programs it runs against Roblox Studio (Explorer, and finding and checking the Studio to work in), so a change in Studio's MCP can be fixed without a new BloxBot release. It keeps the last verified copy and falls back to the programs it shipped with.

### Changed

- Programs BloxBot runs against Studio, including ones the model writes, can only use read-only Studio tools.

## [0.12.1] - 2026-09-28

### Fixed

- Explorer loads the Studio place tree again. Roblox Studio's MCP now requires a data model for `search_game_tree`, which BloxBot didn't send, so Explorer had failed for everyone since mid-August. During a playtest it shows the server data model, and it names the place.
- When the built-in Explorer setup fails on first load, BloxBot has the model write one against Studio's current tools instead of giving up.
- Reopening Explorer retries a setup that failed, and a failing Explorer backs off to a retry every few minutes at most instead of every few seconds.

## [0.12.0] - 2026-09-28

### Added

- Sign in to OpenAI with a device code as well as in the browser, so a ChatGPT Plus or Pro plan still connects when the browser sign-in can't finish.
- Settings → Providers shows provider logos, says how each provider connects, and has a search box.
- Providers that ask a question before signing in, such as GitHub Enterprise for Copilot, now ask it.
- Check any connected provider from Settings → Providers. BloxBot sends one short test message through its cheapest model and shows whether the key or sign-in works, with a Reconnect link when the key is rejected. The toast after connecting offers the same check.
- OpenCode Zen is listed as its own provider in Settings → Providers, separate from the free models. Connect it with a Zen key, and remove the key to go back to the free models.
- Settings → Providers recommends OpenCode Go ($10/month, or Go Plus at $40/month) to people using only the free models, and walks through setting it up.

### Fixed

- A failed sign-in explains what went wrong and suggests the method most likely to work, instead of "Failed to start sign-in flow".
- A sign-in that stalls offers a way back to the other methods and a link to reopen the sign-in page.
- Signing in, saving a key or removing one no longer shows as failed when refreshing the provider list afterwards fails.
- Closing the dialog or going back while a sign-in is starting no longer opens the browser or resumes the abandoned sign-in.
- Replacing the key of an already connected provider closes the dialog instead of leaving it open.
- The models BloxBot includes for free show as "Free models" in Settings and the model picker, rather than "OpenCode Zen", until a Zen key is added.
- Settings no longer squeezes its content into a sliver in narrow windows. When space is tight, its sections become a row of tabs on top.

## [0.11.1] - 2026-09-24

### Added

- Settings → Privacy links to the Privacy Policy and Terms of Service, and shows your device ID for data requests.

## [0.11.0] - 2026-09-24

### Changed

- Usage data now includes your AI chats and tool activity to help improve BloxBot. Turn it off in Settings → Privacy.

## [0.10.0] - 2026-08-20

### Added

- Updated multi-Studio routing for Roblox Studio MCP's stateless `studio_id` contract, including Place ID disambiguation, per-session target restoration, and BloxBot identification in Studio's connected AI client list.

### Fixed

- Removed the obsolete `set_active_studio` flow and now routes chat and Explorer tool calls to the selected Studio explicitly.

## [0.9.1] - 2026-08-09

### Fixed

- Fixed first-run setup failing with `StudioMcpBrokerError` (`spawn cmd.exe ENOENT`) by creating the `~/BloxBot` workspace before launching the Roblox Studio MCP helper; on fresh installs the workspace did not exist yet and Node reports a missing spawn `cwd` as ENOENT on the executable. ([#76](https://github.com/paralov/app-bloxbot-ai/issues/76))

## [0.9.0] - 2026-08-07

### Changed

- Turned model usage metrics into an opt-out setting with a one-time in-app notice; choices recorded under the previous opt-in prompt do not carry over, and the Settings → Privacy toggle remains authoritative.
- Anonymized analytics: events no longer create a person profile. A random device identifier is retained for aggregate counts.

### Fixed

- Fixed a startup failure on Windows when the system `PATH` does not include `System32` by resolving `cmd.exe` through `ComSpec` before launching the Roblox Studio MCP helper. ([#73](https://github.com/paralov/app-bloxbot-ai/issues/73))

## [0.8.0] - 2026-07-27

### Added

- Added session-scoped Roblox Studio targeting with automatic matching, a responsive Studio picker, and a shared Electron-side MCP broker.
- Added an agent-driven Explorer that automatically synchronizes Roblox Studio's instance tree, supports search, properties and attributes, object references, and Studio-style ordering and filtering.
- Added an agent playtest workflow that can generate editable test plans from chat history and send the completed playtest back into the active session.
- Added snoozed sessions with restore-first interactions, contextual deletion, confirmation inside the application, and animated sidebar transitions.
- Added object mentions and OpenCode-backed slash-command completion to the composer, including argument hints and keyboard completion.

### Changed

- Redesigned reasoning, tool calls, structured output, diffs, shell output, retries, and provider errors as compact inline chat content with collapsible syntax highlighting.
- Reworked Explorer and Playtest as matching embedded side panels with responsive header controls and smooth entrance and exit transitions.
- Refined the composer with an expandable input, aligned attachment and submit actions, an in-composer agent selector, and a popover-based reasoning-effort slider.
- Expanded PostHog events with consistent metadata for Studio targeting, Explorer synchronization, playtesting, composer actions, and session management.

### Fixed

- Prevented Studio discovery refreshes, panel switching, disclosure expansion, and responsive header changes from causing flicker, scroll jumps, clipped controls, or layout shifts.
- Added a bundled typed Studio collector and strict schema runtime so common discovery and Explorer flows work without an initial model request while retaining agent-generated fallback behavior.

## [0.7.1] - 2026-07-26

### Fixed

- Replaced raw HTML in update notifications with a compact, readable release summary while preserving the install-and-restart action.

## [0.7.0] - 2026-07-26

### Added

- Added a suggested workflow for coordinating work across multiple open Roblox Studio places, with agent guidance to discover, select, and verify the intended place before place-specific actions.

## [0.6.7] - 2026-07-26

### Fixed

- Replaced the raw startup stack trace with a clear setup-recovery screen, actionable restart and update options, and collapsible copyable technical details for support.

## [0.6.6] - 2026-07-24

### Fixed

- Unblocked Studio setup across platforms by trusting the connected MCP status instead of inspecting OS-specific processes and sockets.

## [0.6.5] - 2026-07-24

### Changed

- Added visible progress while BloxBot checks the Roblox Studio connection.

### Fixed

- Prevented unavailable Studio tool calls by requiring a live Roblox Studio connection before enabling chat.

## [0.6.4] - 2026-07-23

### Added

- Added clear startup stages plus real percentage and transfer-speed feedback while BloxBot downloads OpenCode.

### Changed

- Tightened the Studio agent instructions around inspecting before editing, making focused changes, validating in Studio, and deferring project-specific rules to each workspace's `AGENTS.md`.

## [0.6.3] - 2026-07-23

### Changed

- Simplified desktop analytics to PostHog's built-in defaults, with persistent device identity, device profiling, person profiles, feature flags, and app screen pageviews enabled.

### Fixed

- Restored desktop analytics by injecting the PostHog EU project token during CI builds and loading PostHog's self-contained Electron renderer bundle.
- Replaced analytics' current page URL with stable `bloxbot://app/<screen>` metadata.

## [0.6.2] - 2026-07-21

### Changed

- Model quota failures now use OpenCode's structured status and action data, with native usage-limit guidance for free models instead of message matching.
- Automatic OpenCode context compaction is enabled by default, and the OpenCode SDK has been updated to its current status schema.
- React Query synchronization now uses scoped cache keys, precise event-driven updates, reconnect reconciliation, and targeted mutation rollback instead of broad invalidation.
- Removed the bundled third-party Gemini OAuth plugin; Google API-key authentication and other supported providers remain available.
- Refined the detailed-analytics consent prompt into a compact decision card with full-width copy and clear actions.

### Fixed

- Prevented stale HTTP snapshots and out-of-order event updates from restoring deleted sessions, reviving stale messages, or leaking drafts between conversations.
- Corrected session mutation failure handling, optional action rendering, sidebar interactions, and related React subscription ownership issues.

## [0.6.1] - 2026-07-21

### Changed

- CI and release publishing now share one reusable build workflow, use current Node runtimes for GitHub Actions, and publish only the installers and files required for automatic updates.
- Releases are now assembled as retryable drafts, verified for the exact updater-safe asset set, and published only after every upload succeeds.
- GitHub Actions are pinned to their latest immutable revisions, and write access is limited to the final release-publishing job.
- macOS releases now use one universal installer for Apple Silicon and Intel Macs.
- Release tooling is now TypeScript-only, and the redundant Makefile has been removed in favor of package scripts.
- PostHog now collects basic privacy-minimized feature analytics by default and asks once before enabling detailed provider, model, and aggregate token usage; detailed sharing remains toggleable in Privacy settings.
- Analytics now use a temporary per-launch identifier and a strict outbound property allowlist that removes URLs, device and session identifiers, user-agent details, profile data, and IP-derived location data.

### Fixed

- Added production app-open and model-usage events so PostHog ingestion and aggregate token usage can be monitored without collecting user content.
- Fixed detailed analytics sending user-defined agent names even though the consent prompt did not request them.

## [0.6.0] - 2026-07-21

### Added

- Added a guided, screenshot-based Roblox Studio connection flow that detects the built-in MCP server and reconnects automatically.
- Added detailed startup progress while BloxBot prepares its workspace, downloads OpenCode, and starts the local AI service.
- Added Light, Dark, and System appearance settings, with System following the operating system theme automatically.
- Added native Electron installers for Apple Silicon and Intel macOS, 64-bit Windows, and 64-bit Debian-based Linux.

### Changed

- Replaced the Tauri and Rust desktop shell with Electron, using a typed, context-isolated bridge between the app and desktop runtime.
- OpenCode is now downloaded on first launch instead of bundled with the app. BloxBot selects the newest compatible stable `1.x` release, caches it per platform, and reuses a verified cached copy when offline.
- Reworked desktop services and startup orchestration around Effect for predictable cleanup, bounded startup failures, and clearer error reporting.
- Closing the final window now fully quits BloxBot and its OpenCode process; on macOS, the Dock icon is hidden as the app exits.
- Updated the build and release pipeline for Electron packages, macOS signing and notarization, GitHub releases, and automatic updates.

### Fixed

- Fixed OpenCode startup races by discovering its actual loopback port and waiting for a successful health check before opening the app.
- Fixed development instances remaining alive after their last window closes.
- Fixed missing Linux package maintainer metadata.
- Improved event-stream cleanup and desktop error handling during startup, shutdown, and updates.

### Security

- OpenCode now runs on a random loopback port with per-launch credentials rather than exposing an unauthenticated local service.
- OpenCode downloads are restricted to official GitHub release assets and verified with SHA-256 digests before installation and on every cache reuse.
- Electron runs with context isolation, renderer sandboxing, Node.js integration disabled, validated IPC payloads, and external navigation blocked.

[Unreleased]: https://github.com/paralov/app-bloxbot-ai/compare/v0.12.1...HEAD
[0.12.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.7...v0.7.0
[0.6.7]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.6...v0.6.7
[0.6.6]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.5...v0.6.6
[0.6.5]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.4...v0.6.5
[0.6.4]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.5.2...v0.6.0
