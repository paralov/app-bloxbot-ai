# Changelog

All notable changes to BloxBot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Simplified desktop analytics to PostHog's built-in defaults, with persistent device identity, person profiles, and feature flags enabled.

### Fixed

- Restored desktop analytics by injecting the PostHog EU project token during CI builds and loading PostHog's self-contained Electron renderer bundle.

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

[Unreleased]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.5.2...v0.6.0
