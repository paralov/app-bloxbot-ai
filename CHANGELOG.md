# Changelog

All notable changes to BloxBot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- Intel Macs are no longer supported, and BloxBot for Mac now requires Apple Silicon. Intel Macs stay on v0.14.0.

### Changed

- BloxBot works without Studio, for things like small websites. Skip setup the first time, or choose Work without Studio in any chat.
- A chat is tied to a place once the agent has used it. If that place closes while another is open, BloxBot asks before going on, so the agent can't change the wrong one. It picks the place back up when it reopens, and commands like `/new` and `/model` always run.
- A Studio with the same name as a chat's unpublished place is offered with one click rather than taken, since every new template is a Baseplate.
- When several Studios are open and a chat hasn't used one, the agent asks which one before touching Studio.
- Keyboard focus is easier to see across the app.
- A reply can link to a file it made, and clicking shows you where it is.
- Finishing or skipping Studio setup starts a new chat.

### Fixed

- On Windows, replacing a broken copy of BloxBot's engine waits for antivirus to let go of it, instead of failing with EPERM
- Windows: BloxBot now reads OpenCode's port from its output, for machines stuck at startup on "OpenCode did not open a listening port".
- Slow connections can finish downloading OpenCode. A download now stops only after 60 seconds with no data, and carries on from where it stopped, even after a restart.
- BloxBot opens straight away when a working engine is installed, and any newer version downloads in the background for next launch.
- Downloads refused over an unknown certificate, as behind some company networks and antivirus software, retry with your system's certificates. The file must still match the same checksum.
- Installing OpenCode waits longer for antivirus software to release a new file, and doesn't download again after antivirus blocks unpacking.
- Startup failures say what to try next and show the folder to allow in antivirus software. BloxBot also looks for an update by itself, and a step that has gone quiet says so and offers Try again.
- Refresh in the Studio picker now shows what it found, and the steps to connect Studio are right there when none are found. Three empty Refreshes bring them to the front.
- The setup screen no longer cuts off its top in a short window.
- The Explorer shows a short notice when Studio closes, has no place open, is loading or is starting or stopping a playtest, and picks up again on its own without being in front.
- What you've typed in the message box survives Settings, the Studio setup screen, switching chats, Reconnect and restarting BloxBot, including references to objects.
- A chat's Playtest closes when you switch chats, so its plan can't run in another one.
- The Explorer keeps what's open, selected and searched when its panel closes, and remembers each place.
- Reconnect restarts an engine that has stopped, rather than reloading into an error.

## [0.14.0] - 2026-11-04

### Added

- Connect Claude Agent to use your Claude plan through your own Claude Code login.
- Objects a reply mentions in code formatting open in the Explorer when clicked.
- The Explorer shows properties for services and Terrain, with rounded numbers and readable values.
- Tools on your shell's PATH, like Claude Code, are now found when BloxBot is opened from the Finder.
- BloxBot no longer picks up skills, instructions or config from `~/.claude`, `~/.agents` or `~/.opencode`, or from `AGENTS.md` and `opencode.json` files in folders above or inside `~/BloxBot`. Use Settings → Instructions instead.
- AI usage data no longer includes instruction files from outside BloxBot's folder, such as `~/.claude/CLAUDE.md`.
- Providers show OpenCode's official logos, which work offline.
- System notifications. While BloxBot isn't the app in front, it tells you when a chat finishes, runs into a problem, or is waiting for an answer or your approval, and when an update is ready or the connection is lost. Clicking one takes you to that chat. Turn them off in Settings → Notifications.
- A toast when a chat you aren't looking at finishes or needs you, with a button to open it.
- Settings → Instructions: tell BloxBot what to keep in mind in every chat. They're saved as BloxBot's own `AGENTS.md`.
- The system prompt can still be edited under Settings → Instructions, with a warning: it can make BloxBot worse at Studio work, and your next message costs more.
- Choose which notifications you get: a chat finishing, needing you, or running into a problem, and updates and connection problems. They come with a soft chime you can turn off, and a test button.
- On a Mac, BloxBot offers once to turn notifications on, and Settings → Notifications can open your system's notification settings.
- A one-time invitation to star BloxBot on GitHub, shown when you open BloxBot if you already have chats, otherwise after your third prompt.

### Changed

- A redesigned interface: one calm surface for chats, compact tool activity you can open for detail, a single message box with your model and effort, and a clearer working state.
- Reasoning effort now names its choices and explains what they do.
- Settings → Privacy has shorter text, and data requests now go to support@bloxbot.ai.
- The model picker has a way to add providers and models.
- Settings → Providers lists each connected provider's models under it, replacing the separate Models tab.
- Settings → About links to Paralov, Studs.gg, the Privacy Policy and the Terms of Service.
- Drag an object from Explorer into your message to reference it, the same as an `@` mention.
- Explorer shows an object's name and path with its properties, and keeps attributes on their own tab.
- Right-click an object in Explorer to reference it in chat, copy its path, or rename, duplicate or delete it where Roblox allows.
- Explorer shows every property Studio exposes, including Position, CFrame and Pivot for parts and Models, grouped by category. Change them in place with dropdowns, a color wheel, a BrickColor palette and X, Y and Z fields. Numbers read the same everywhere, without long decimals.
- Add, change and remove attributes from Explorer, and add and remove tags.
- Objects with the same name each get their own row in Explorer, with their own children and values.
- Explorer stays out of Studio's redo while you look around, apart from once when you first select an object after opening Studio. While there's something to redo, it hides computed values like Mass until there isn't.
- Explorer handles very large places. Objects appear as they're read instead of all at once, Studio no longer stalls on one long read in most places, the list stays smooth with tens of thousands of objects open, and when nothing has changed in Studio it hardly asks at all.
- Explorer shows objects below Studio's depth limit, and the right children under each of any number of objects with the same name.
- Right-click a property or attribute to reference it in chat or copy its value. Referenced properties, attributes and tags each have their own color and icon.
- Notifications appear at the bottom right.
- `@` and `/` suggestions open above the message box, find objects even with Explorer closed, and rank the closest matches first.
- Explorer and Playtest moved to the top bar.
- A goal now shows above the message box, with its objective and buttons to pause, resume or clear it.
- The agent's plan is now a small pill above the message box while it works, instead of a card in the chat.
- A desktop text scale, based on OpenCode's and macOS's, replaces web-sized text.
- The free limit message goes quiet once the limit has reset or the chat has moved on, and counts down from when you hit it.
- Slash commands now actually run, matching OpenCode's desktop app: `/goal`, `/init`, `/review`, custom commands, `/new`, `/undo`, `/redo`, `/compact`, `/fork`, `/export`, `/model`, `/connect` and `/reload`.
- File edits from GPT models show as edits instead of an unknown tool.
- BloxBot now runs on OpenCode 2. OpenCode no longer supports free models on version 1. Your chats and connected providers carry over.
- Chats use OpenCode's Code Mode, so a model can script several Studio tool calls in one step. The chat shows the code it ran and the result.

### Removed

- Token counts in the chat.
- The free limit popup. The chat now explains the limit in place.
- The agent picker. BloxBot now has one assistant, and you change how it behaves with Settings → Instructions.
- Explorer no longer asks your model to write a program when its built-in one fails, so it can't use up your free messages. It keeps the last tree on screen and retries on its own.
- The downloadable programs behind Explorer and Studio selection. These now ship with the app, so a change on Roblox's side needs an app update.

### Fixed

- Chats no longer get stuck on "Thinking..." or "Waiting to retry" when you reach the free limit. The chat stops and says when your free messages reset and how to keep going.

## [0.13.7] - 2026-10-01

### Changed

- The Windows installer and app are now signed by Paralov AS.

## [0.13.6] - 2026-09-30

### Fixed

- First-time setup on Windows now tries unpacking OpenCode again when antivirus software locks or removes it for a moment. If it stays blocked, or the drive is nearly full, the setup screen says so and what to do, and the error report says which step failed and why.

## [0.13.5] - 2026-09-30

### Fixed

- BloxBot no longer stops at setup when GitHub refuses or doesn't answer the check for OpenCode updates. It downloads a known-good OpenCode version directly instead, and the error says what went wrong if even that download fails.
- When OpenCode stops during startup or never finishes starting, the error now includes the last lines OpenCode printed, so reports show why.
- When Explorer has the model write its own program and the model returns nothing, BloxBot now reports the model's own error instead of a generic decode error. The model is also kept from calling Studio tools while it writes the program, so it can't stall waiting for an approval.
- BloxBot now finds Studio's MCP helper in the newer Roblox Studio install folder on Windows, so fewer people end up on Studio's broken launcher.
- Updating the BloxBot programs no longer fails when two updates run at the same time, and the saved copy can't be read half written.
- Generating a playtest plan fails less often. When the model answers without a plan, BloxBot reminds it once to return the plan and tries again.

## [0.13.4] - 2026-09-29

### Fixed

- BloxBot now connects to Roblox Studio on Windows even when Studio's own MCP launcher is broken after a Studio update. It finds and starts Studio's MCP helper itself.

## [0.13.3] - 2026-09-29

### Changed

- Check's error reports include the model name again, since it helps tell where an error came from.
- The Privacy settings say that error reports can name the provider and model an error came from, and stay on when Share AI usage data is off.

### Fixed

- When Explorer has the model write its own program, that program works more often. It can call Studio's tools by the names the model sees, the model is told exactly which tools it may use, and BloxBot tries each program once before using it and gives the model one chance to fix a program that fails.
- BloxBot no longer stops at a setup error when it can't reach Roblox Studio's MCP helper at launch. It retries for about 30 seconds, keeps working while it waits, and the Studio setup screen says how to fix it when Studio's MCP helper is missing or keeps closing.
- Generating a playtest plan now works, including on OpenCode's free models. Before, it failed almost every time.
- When plan generation fails, the Playtest panel shows the provider's error instead of saying the plan was invalid.
- Generate from chat is turned off in a chat with no messages yet, with a note that plans are built from the conversation. Write my own still works.

## [0.13.2] - 2026-09-28

### Fixed

- Check in Providers lets you pick the model to test, starting with the model you chat with or the provider's default. It had picked models your key or plan might not include, so working connections showed as failing. The result names the model it checked.
- Error reports also remove email addresses, and Check's error reports leave out model names unless Share AI usage data is on.

## [0.13.1] - 2026-09-28

### Added

- BloxBot reports errors from the app and its background process so we can find and fix them. Personal file paths, usernames and API keys are removed before anything is sent.

### Fixed

- Check in Providers tests the model you chat with, or the provider's default, instead of the cheapest model on the list. It had picked image-only and limited preview models, so working keys and sign-ins showed as failing.

## [0.13.0] - 2026-09-28

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

[Unreleased]: https://github.com/paralov/app-bloxbot-ai/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.7...v0.14.0
[0.13.7]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.6...v0.13.7
[0.13.6]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.5...v0.13.6
[0.13.5]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.4...v0.13.5
[0.13.4]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.3...v0.13.4
[0.13.3]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/paralov/app-bloxbot-ai/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/paralov/app-bloxbot-ai/compare/v0.12.1...v0.13.0
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
