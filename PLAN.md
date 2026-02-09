# BloxBot Planning Document

> **Status**: Pre-development  
> **Last updated**: 2026-02-09  
> **Website**: bloxbot.ai

## 1. Product Vision

BloxBot is a desktop app that gives Roblox creators a one-click path to AI-assisted
game development. Download one binary, run it, and you're connected: the Roblox Studio
MCP server is running, the Studio plugin is installed, and (optionally) a chat interface
is ready to go. No terminal, no config files, no `npx`.

### Target audience

Roblox creators — a mix of experienced Luau developers and less-technical game builders
who use Studio visually. The setup experience must work for people who have never opened
a terminal.

### Core value proposition

Today, connecting an AI assistant to Roblox Studio requires installing Node.js, running
`npx`, editing JSON config files, and manually placing a Studio plugin. BloxBot replaces
all of that with a single installer.

---

## 2. Scope

### MVP (v0.1) — "One-click setup"

The minimum viable product ships three things in one Tauri binary:

1. **MCP server management** — Run the
   [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) server
   (TypeScript, 37+ tools, MIT licensed) via the **bundled Bun runtime** (`bunx
   robloxstudio-mcp`). The package is downloaded and cached on first launch — the user
   installs nothing. The Tauri app starts it as a child process, monitors its health,
   and exposes start/stop/restart controls in the UI.

2. **Roblox Studio plugin installation** — Automatically copy the companion Luau plugin
   (`MCPPlugin.rbxmx`) into the user's Roblox Studio plugins directory
   (`%LOCALAPPDATA%/Roblox/Plugins` on Windows, `~/Documents/Roblox/Plugins` on macOS).
   Show the user a confirmation. No manual Studio settings changes needed — plugins can
   make localhost HTTP requests without the "Allow HTTP Requests" game setting.

3. **Status dashboard** — A simple React UI that shows:
   - MCP server status (running / stopped / error)
   - Studio plugin install status
   - Connection health (can the MCP server reach Studio?)
   - Quick-action buttons: start, stop, restart, reinstall plugin
   - Logs panel (stdout/stderr from the MCP server)

### Post-MVP — "Chat interface" (v0.2+)

Run [OpenCode](https://opencode.ai) (MIT licensed) via the same **bundled Bun runtime**
(`bunx opencode-ai`) and embed a custom React chat UI that talks to its server API.
This gives users a built-in Claude/GPT/local-model chat window pre-configured with the
Roblox MCP server — no external AI client needed. Same pattern as the MCP server:
downloaded and cached on first launch, trivially updatable.

This is **not confirmed for MVP**. The scope decision depends on:
- Whether the setup-only MVP is useful enough on its own (it is — users can point Claude
  Desktop or Cursor at the MCP server BloxBot manages).
- How much complexity the OpenCode integration adds (it has a client/server architecture
  that should make embedding feasible, but needs a spike to confirm).

### Future / low-priority — "Remote access / tunneling"

Expose the local MCP server over the internet so non-local AI clients (Claude.ai web,
mobile, team members) can connect via a tunnel (e.g., Cloudflare Tunnel, bore, ngrok).
The MCP spec's Streamable HTTP transport (2025-03-26) is designed for this.

This is **low priority** — an advanced-user feature. The primary path for most users is
the integrated OpenCode chat interface (Phase 4), which runs locally and doesn't need a
tunnel. Remote access adds significant security complexity (auth, token management,
exposure of Studio to the internet) for a niche audience. Revisit only if there's clear
user demand after the chat interface ships.

### Explicitly out of scope (for now)

- Cloud/web version — desktop only
- Linux support — Roblox Studio doesn't run on Linux
- Building our own MCP server — we use boshyxd/robloxstudio-mcp
- Server-side infrastructure — no relay servers, no hosted backends, no infra to operate
- User accounts / authentication / telemetry (tunnel auth is local token-based, no server)
- Auto-update mechanism (evaluate after MVP)

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│                   BloxBot (Tauri)                    │
│                                                     │
│  ┌──────────────┐         ┌──────────────────────┐  │
│  │  React UI    │◄─invoke─►  Rust Backend        │  │
│  │              │         │                      │  │
│  │  - Dashboard │         │  - MCP process mgmt  │  │
│  │  - Logs      │         │  - Plugin installer  │  │
│  │  - Settings  │         │  - Health checks     │  │
│  │  - Chat      │         │  - System paths      │  │
│  │              │         │  - OpenCode mgmt     │  │
│  └──────────────┘         └──────────┬───────────┘  │
│                                      │              │
│                           ┌──────────▼───────────┐  │
│                           │  Child processes:    │  │
│                           │  bun + robloxstudio  │  │
│                           │  bun + opencode-ai   │  │
│                           │  (via bundled Bun)   │  │
│                           └──────────┬───────────┘  │
│                                      │              │
└──────────────────────────────────────┼──────────────┘
                                       │ HTTP (localhost)
                              ┌────────▼────────┐
                              │  Roblox Studio  │
                              │  (Luau plugin)  │
                              └─────────────────┘
```

### Key architectural decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| JS runtime | Bundle Bun binary (~50MB) | Ship the Bun binary inside the Tauri resource bundle. Use `bunx` at runtime to install and run both robloxstudio-mcp and opencode-ai. No pre-compilation, no Node, no user-facing installs. Packages download on first launch and are cached locally. Enables easy version pinning and updates without rebuilding BloxBot. |
| MCP communication | Child process stdio | The MCP server speaks stdio transport to AI clients. BloxBot manages it as a child process and proxies its stdio for logging. |
| Plugin install | File copy | The Studio plugin is a `.lua`/`.rbxm` file. We embed it in the Tauri bundle and copy it to the known plugins directory. |
| Frontend state | React + lightweight state (useState/useReducer) | No need for Redux/Zustand at MVP scale. Reconsider if chat UI lands. |
| Platform paths | Rust `dirs` crate | Resolve platform-specific paths (AppData, Documents, etc.) in Rust, expose via Tauri commands. |
| Remote access (future) | MCP Streamable HTTP + tunnel | Low priority. MCP spec supports HTTP+SSE transport natively. Would need a tunnel provider + auth layer. Only pursue if users ask for it after the OpenCode chat ships. |

---

## 4. Development Phases

### Phase 0 — Project bootstrap (current)
- [x] Scaffold Tauri + React + TypeScript project
- [x] Create AGENTS.md for AI agent context
- [x] Create this planning document
- [ ] Rename app from "tauri-app" to "BloxBot" (package.json, Cargo.toml, tauri.conf.json, window title, identifier → `ai.bloxbot.app`)
- [ ] Initialize git repo, initial commit
- [ ] Set up basic CI (GitHub Actions: `pnpm build`, `cargo check`, `cargo clippy`)

### Phase 1 — MCP server integration
- [ ] **Spike**: Validate Bun bundling strategy
  - Download Bun binary for macOS and Windows, confirm sizes (~50MB each)
  - Test `bunx robloxstudio-mcp` — does it install, start, and respond to stdio MCP?
  - Test `bunx opencode-ai` — does it install and start the server process?
  - Measure first-launch download time and cache size for both packages
  - Confirm cached packages survive app restarts (Bun's global cache)
  - Define version pinning strategy (`bunx robloxstudio-mcp@1.9.0` vs `@latest`)
  - **Write a short ADR (Architecture Decision Record) with the outcome**
- [ ] Implement Rust module: `mcp_process.rs`
  - Start/stop/restart the MCP server as a child process
  - Capture stdout/stderr into a ring buffer
  - Health check (is the process alive? can it respond to HTTP?)
  - Tauri commands: `start_mcp`, `stop_mcp`, `restart_mcp`, `get_mcp_status`, `get_mcp_logs`
- [ ] Implement Rust module: `plugin_installer.rs`
  - Detect OS and resolve Studio plugins directory
  - Check if plugin is already installed (file hash comparison)
  - Copy plugin file from app bundle to plugins directory
  - Tauri commands: `install_plugin`, `get_plugin_status`, `get_studio_plugin_path`
- [ ] Embed the robloxstudio-mcp Studio plugin file in the Tauri resource bundle

### Phase 2 — Dashboard UI
- [ ] Design wireframe for dashboard (single page, simple)
- [ ] Implement `StatusCard` component — shows MCP server state with start/stop/restart
- [ ] Implement `PluginStatus` component — shows install state, reinstall button
- [ ] Implement `LogViewer` component — scrollable log output from MCP server
- [ ] Implement `SetupGuide` component — first-run instructions (restart Studio to load plugin, etc.)
- [ ] Implement `ConnectionHealth` component — polls MCP ↔ Studio connectivity
- [ ] Wire all components to Tauri backend via `invoke` calls
- [ ] Basic styling — clean, simple, dark theme (Roblox aesthetic)

### Phase 3 — Packaging & distribution
- [ ] Configure Tauri bundler for macOS `.dmg` (drag-to-Applications) and Windows `.exe` / `.msi` (NSIS or WiX installer)
- [ ] Set app icon and branding
- [ ] Test full install → setup → connect flow on clean macOS machine
- [ ] Test full install → setup → connect flow on clean Windows machine
- [ ] Create GitHub Releases pipeline
- [ ] Write user-facing README / landing page content for bloxbot.ai
- [ ] **MVP ship target**

### Phase 4 — Chat interface (post-MVP, tentative)
- [ ] **Spike**: Evaluate OpenCode integration
  - Test `bunx opencode-ai` — does the server start and expose its API?
  - Can our React frontend talk to OpenCode's server API?
  - Can we pre-configure OpenCode with robloxstudio-mcp as an MCP tool via config?
  - What does the auth/API key flow look like for the end user?
  - **Write ADR with findings**
- [ ] Implement OpenCode process management in Rust backend (same pattern as MCP server — child process via bundled Bun)
- [ ] Implement chat UI component (message list, input, streaming responses)
- [ ] Pre-configure OpenCode with the robloxstudio-mcp server as an MCP tool
- [ ] API key management UI (user enters their own key, stored in OS keychain)
- [ ] Test end-to-end: user sends chat message → OpenCode → LLM → MCP tool call → Studio

### Phase 5 — Polish & growth
- [ ] Auto-update mechanism (Tauri updater plugin)
- [ ] Onboarding flow / first-run wizard
- [ ] Settings page (MCP server port, model selection, theme)
- [ ] Error recovery and user-friendly error messages
- [ ] Analytics (opt-in, privacy-respecting)

---

## 5. Technical Risks & Open Questions

| # | Risk / Question | Impact | Mitigation |
|---|----------------|--------|------------|
| 1 | **Bun cache corruption or registry outage**: If npm registry is down or the Bun cache gets corrupted, the MCP server won't start. | Low | Show clear error with a "retry" button. Add a "clear cache and reinstall" option in settings. Registry outages are rare and transient. |
| 2 | **Studio plugin directory varies by OS / Studio version** | Medium | Test on both platforms. Use well-known paths, fall back to user-selected directory. |
| 3 | **MCP server stability**: boshyxd/robloxstudio-mcp is a community project (141 stars, 5 contributors). Could have bugs or go unmaintained. | Medium | Pin to a specific version. Fork if needed. Long-term: consider the official Roblox/studio-rust-mcp-server (Rust, 271 stars, backed by Roblox) as an alternative — it would eliminate the Node dependency entirely. |
| 4 | **OpenCode integration complexity**: OpenCode's client/server architecture is new and may have rough edges. | Medium | Defer to post-MVP. Run a time-boxed spike before committing. |
| 5 | **Code signing**: macOS and Windows both require signed binaries for a good install experience. Unsigned apps trigger scary warnings. | High | Budget for Apple Developer ($99/yr) and Windows code signing cert. Can ship unsigned for early alpha testers. |
| 6 | ~~**HTTP requests security**~~: Not a concern. Studio plugins can make localhost HTTP requests without the "Allow HTTP Requests" game setting (that setting only applies to in-game `HttpService` calls). No manual user step needed. | None | N/A |
| 7 | **Remote tunneling** (future, low priority): Exposing the MCP server to the internet has security, reliability, and transport compatibility concerns. | Low | Not planned until after OpenCode chat ships and only if users request it. The integrated chat interface is the primary path. No server-side infrastructure. |

---

## 6. Key Dependencies

| Dependency | Version | Role | Bundled how | License |
|-----------|---------|------|------------|---------|
| [Bun](https://bun.sh) | latest stable | JS/TS runtime for child processes | Binary embedded in Tauri resources (~50MB per platform) | MIT |
| [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) | v1.9.0 (pinned) | MCP server + Studio plugin | Downloaded via `bunx` on first launch, cached | MIT |
| [OpenCode](https://opencode.ai) | v1.x (post-MVP) | AI chat backend | Downloaded via `bunx` on first launch, cached | MIT |
| [Tauri](https://tauri.app) | v2 | Desktop app framework | Compiled into the app | MIT/Apache-2.0 |
| [React](https://react.dev) | v18 | Frontend UI | Compiled into the app | MIT |

### Alternative MCP servers (evaluated, not chosen)

| Server | Why not (for now) |
|--------|------------------|
| [Roblox/studio-rust-mcp-server](https://github.com/Roblox/studio-rust-mcp-server) | Rust-based (no Node dependency!), official Roblox project, 271 stars. Strong candidate if we want to eliminate Node. However, it has fewer tools (2 vs 37+) and a different plugin. Revisit after MVP. |

---

## 7. File Structure (Target)

```
tauri-app/
├── src/                          # React frontend
│   ├── components/
│   │   ├── StatusCard.tsx
│   │   ├── PluginStatus.tsx
│   │   ├── LogViewer.tsx
│   │   ├── SetupGuide.tsx
│   │   └── ConnectionHealth.tsx
│   ├── hooks/
│   │   ├── useMcpStatus.ts
│   │   └── usePluginStatus.ts
│   ├── types/
│   │   └── index.ts              # Shared TypeScript types
│   ├── App.tsx
│   ├── App.css
│   └── main.tsx
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs                # Tauri setup, command registration
│   │   ├── mcp_process.rs        # MCP server child process management
│   │   ├── plugin_installer.rs   # Studio plugin file operations
│   │   ├── health.rs             # Health check logic
│   │   └── paths.rs              # Platform-specific path resolution
│   ├── resources/
│   │   ├── bin/
│   │   │   └── bun               # Bundled Bun binary (per-platform)
│   │   └── studio-plugin/        # Embedded Studio plugin files
│   ├── Cargo.toml
│   └── tauri.conf.json
├── docs/
│   └── adr/                      # Architecture Decision Records
│       └── 001-mcp-server-runtime.md
├── AGENTS.md
├── PLAN.md                       # This file
└── package.json
```

---

## 8. Definition of Done — MVP

The MVP is shippable when a user can:

1. Download a `.dmg` (macOS) or `.exe` installer (Windows) from bloxbot.ai
2. Run it — no other software to install (Node.js dependency resolved)
3. See a dashboard confirming the MCP server is running
4. See a confirmation that the Studio plugin was installed
5. Open Roblox Studio and see the MCP plugin active
6. Point Claude Desktop, Cursor, or another MCP client at the running server
7. Successfully issue an AI command that modifies something in Studio

---

## 9. Maintaining This Document

This is a living document. Update it when:
- A phase is completed (check off items, note the date)
- An architectural decision is made (add to section 3 or link an ADR)
- Scope changes (move items between MVP / post-MVP / out of scope)
- New risks are identified (add to section 5)

AI agents working in this repo should read both `AGENTS.md` (coding conventions) and
`PLAN.md` (product context) before starting work.
