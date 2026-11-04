# BloxBot

AI-assisted Roblox development. BloxBot is a free, open-source desktop app that connects any AI model to Roblox Studio's official MCP server, so you can build games by describing what you want.

**[Download the latest release](https://github.com/paralov/app-bloxbot-ai/releases/latest)** | **[Website](https://bloxbot.ai)**

## What it does

- Chat with AI models (Claude, GPT, Gemini, and more) that can read and modify your Roblox Studio project in real time
- Create scripts, build UI, manipulate the explorer hierarchy, edit properties - all through natural language
- Browse your place in a built-in Explorer, even with very large places, and edit properties, attributes and tags by hand. Drag any object into your message to talk about it
- Uses Roblox Studio's [built-in MCP server](https://create.roblox.com/docs/studio/mcp), giving the AI structured access to Studio. No plugins to install
- Start with free models, bring your own API key from any supported provider, or connect via OAuth. You can also use your Claude plan through your own Claude Code login, at your own risk: BloxBot explains this before you connect
- Get notified when a chat finishes or needs you, while you work in Studio

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
4. Use the free models, or connect an AI provider in BloxBot's Settings → Providers
5. Start building

### Customizing

Tell BloxBot what to keep in mind in every chat in **Settings → Instructions**. They're saved as BloxBot's own `AGENTS.md`, in `~/BloxBot/.opencode/config/opencode/`.

BloxBot keeps other setups out, so it doesn't load `~/.claude`, `~/.agents` or `~/.opencode`, or `AGENTS.md` and `opencode.json` files anywhere else.

### Platform notes

**macOS**: The app is signed and notarized. Open the `.dmg` and drag BloxBot to Applications.

**Windows**: From v0.13.7, the installer and app are signed by Paralov AS. SmartScreen may still warn about a new release for a while. Click "More info" then "Run anyway".

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

On first launch, BloxBot downloads the newest compatible OpenCode `2.2.x`
release and verifies its SHA-256 digest. Later launches check for newer
patch releases and can fall back to the newest verified cached copy
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
  explorerTree.ts       #   Reads Studio's tree in short pieces and sends what changed
  studioQueries.ts      #   Studio targets, and reading and editing objects
  services/OpenCodeBinary.ts # Runtime download and verified per-user cache
  services/OpenCode.ts  #   Effect-scoped OpenCode process lifecycle
  services/StudioMcpBroker.ts # Connection to Roblox Studio's MCP server
```

### Key commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run the full app in dev mode |
| `pnpm package` | Production build and installers |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check app, Electron, and release scripts |
| `pnpm lint` | Lint frontend code (Biome) |

Some tests run a real OpenCode with a scripted model, so they need no model or free quota. They're skipped unless you point them at a binary:

```sh
OPENCODE_LIVE_BIN=/path/to/opencode pnpm vitest run src/test/workflows.test.tsx src/test/opencodeLive.test.ts
```

## Tech stack

- **Frontend**: React 18, TypeScript, TanStack React Query, Tailwind CSS
- **Desktop runtime**: Electron with Effect-managed services
- **AI engine**: [OpenCode](https://opencode.ai)
- **Studio integration**: [Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp) (built-in)
- **Testing**: Vitest, React Testing Library

## License

[MIT](LICENSE)
