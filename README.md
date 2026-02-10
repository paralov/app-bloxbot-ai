# BloxBot

AI-assisted Roblox development. BloxBot is a desktop app that connects your favorite AI models directly to Roblox Studio, so you can build games by describing what you want.

**[Download the latest release](https://github.com/paralov/app-bloxbot-ai/releases/latest)**

## What it does

- Chat with AI models (Claude, GPT, Gemini, and more) that can read and modify your Roblox Studio project in real time
- Create scripts, build UI, manipulate the explorer hierarchy, edit properties -- all through natural language
- Works through [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), giving the AI structured access to Studio rather than just generating code snippets
- Bring your own API key from any supported provider, or connect via OAuth (OpenRouter, etc.)

## How it works

BloxBot bundles three things into a single installer:

1. **A desktop app** (Tauri v2 -- React frontend, Rust backend) where you chat with AI
2. **An AI server** ([OpenCode](https://github.com/anomalyco/opencode)) that manages model connections, sessions, and tool use
3. **A Roblox Studio plugin** that bridges Studio to the AI through a local MCP server

When you type a message, the AI can use MCP tools to directly inspect and modify your open Roblox Studio project.

## Installation

Download the installer for your platform from the [releases page](https://github.com/paralov/app-bloxbot-ai/releases/latest):

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `BloxBot_x.x.x_aarch64.dmg` |
| Windows (64-bit) | `BloxBot_x.x.x_x64-setup.exe` |

### First launch notes

**macOS**: The app is not yet signed with an Apple Developer certificate. Right-click the app and choose "Open" to bypass Gatekeeper on first launch.

**Windows**: SmartScreen may warn about an unknown publisher. Click "More info" then "Run anyway".

On first launch, BloxBot will walk you through connecting an AI provider and installing the Roblox Studio plugin.

## Development

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+

### Setup

```sh
# Install frontend dependencies
pnpm install

# Download bundled runtimes (Node.js + OpenCode sidecar)
make deps

# Run in development mode
make dev
```

Or use the Tauri CLI directly:

```sh
pnpm tauri dev    # development
pnpm tauri build  # production build
```

### Project structure

```
src/                  # React/TypeScript frontend
src-tauri/            # Rust backend
  src/lib.rs          #   App setup, menu, window management
  src/opencode.rs     #   OpenCode server lifecycle
  src/paths.rs        #   Path resolution (sidecar, Node.js, plugin)
  resources/          #   Bundled resources (Node.js, Studio plugin)
  binaries/           #   OpenCode sidecar binary (downloaded at build time)
```

### Key commands

| Command | Description |
|---------|-------------|
| `make dev` | Run the full app in dev mode |
| `make build` | Production build |
| `make check` | Type-check frontend + Rust |
| `pnpm lint` | Lint frontend code (Biome) |
| `cargo clippy` | Lint Rust code |

## License

[MIT](LICENSE)
