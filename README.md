# BloxBot

AI-assisted Roblox development. BloxBot is a free, open-source desktop app that connects any AI model to Roblox Studio's official MCP server, so you can build games by describing what you want.

**[Download the latest release](https://github.com/paralov/app-bloxbot-ai/releases/latest)** | **[Website](https://bloxbot.ai)**

## What it does

- Chat with AI models (Claude, GPT, Gemini, and more) that can read and modify your Roblox Studio project in real time
- Assign chat sessions to different open Studio places and work on them in parallel
- Create scripts, build UI, manipulate the explorer hierarchy, edit properties  - all through natural language
- Uses Roblox Studio's [built-in MCP server](https://create.roblox.com/docs/studio/mcp), giving the AI structured access to Studio. No plugins to install
- Bring your own API key from any supported provider, or connect via OAuth

## How it works

BloxBot connects two things:

1. **A desktop app** (Electron, Effect, and React) where you chat with AI
2. **An AI server** ([OpenCode](https://github.com/anomalyco/opencode)) that manages model connections, sessions, and tool use

The AI connects to Roblox Studio through its official built-in MCP server. When you type a message, the AI uses MCP tools to directly inspect and modify your open Studio project.

## Installation

Download the installer for your platform from the [releases page](https://github.com/paralov/app-bloxbot-ai/releases/latest):

| Platform | File |
|----------|------|
| macOS (Apple Silicon and Intel) | `BloxBot-x.y.z-mac.dmg` |
| Windows (64-bit) | `BloxBot-Setup-x.y.z.exe` |
| Debian / Ubuntu (64-bit) | `BloxBot-x.y.z-linux-amd64.deb` |

### Setup

1. Install and open BloxBot
2. Open Roblox Studio and open (or create) a place
3. In Studio, open **Assistant** settings (three-dot menu) → **MCP Servers** → enable **Studio as MCP server**
4. Connect an AI provider in BloxBot's Settings → Providers
5. Start building

### Platform notes

**macOS**: The app is signed and notarized. Open the `.dmg` and drag BloxBot to Applications.

**Windows**: SmartScreen may warn about an unknown publisher. Click "More info" then "Run anyway".

**Linux**: Install the `.deb` with your software center or `sudo apt install ./BloxBot-*.deb`.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [pnpm](https://pnpm.io/) 10+

### Setup

```sh
# Install frontend dependencies
pnpm install

# Run in development mode
pnpm dev
```

Production builds require `VITE_POSTHOG_PROJECT_TOKEN`. Copy `.env.example` to
`.env.local` for local packaging. GitHub Actions injects the public project token
from the `POSTHOG_PROJECT_TOKEN` repository variable when building release artifacts.

On first launch, BloxBot downloads the newest compatible OpenCode `1.x.x`
release and verifies its SHA-256 digest. Later launches check for compatible
minor and patch updates and can fall back to the newest verified cached copy
when offline.

### Project structure

```
src/                    # React/TypeScript frontend
  components/           #   UI components (Chat, Settings, Sidebar, etc.)
  hooks/                #   React Query hooks (queries + mutations)
  lib/                  #   Pure utilities (sseDispatch, queryKeys, splitModelKey)
  providers/            #   Context providers (OpenCodeClient, ActiveSession, Preferences)
  test/                 #   Test setup and utilities
electron/               # Electron main process and preload bridge
  icons/                #   Desktop installer icons
  main.ts               #   Secure window, IPC, updates, and lifecycle
  services/OpenCodeBinary.ts # Runtime download and verified per-user cache
  services/OpenCode.ts  #   Effect-scoped OpenCode process lifecycle
```

### Key commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run the full app in dev mode |
| `pnpm package` | Production build and installers |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check app, Electron, and release scripts |
| `pnpm lint` | Lint frontend code (Biome) |

## Tech stack

- **Frontend**: React 18, TypeScript, TanStack React Query, Tailwind CSS
- **Desktop runtime**: Electron with Effect-managed services
- **AI engine**: [OpenCode](https://opencode.ai)
- **Studio integration**: [Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp) (built-in)
- **Testing**: Vitest, React Testing Library

## License

[MIT](LICENSE)
