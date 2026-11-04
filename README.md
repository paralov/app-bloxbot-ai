# BloxBot

Build Roblox games by describing what you want.

**[Download](https://github.com/paralov/app-bloxbot-ai/releases/latest)** | **[Website](https://bloxbot.ai)**

BloxBot is a free, open-source desktop app that connects AI models to Roblox Studio. It can read your place, write scripts, build UI and change objects while you watch. It uses [Studio's official MCP server](https://create.roblox.com/docs/studio/mcp), so there's no plugin to install.

## Why BloxBot

Roblox Studio can work with AI tools, but getting there usually means setting up a coding agent, config files and API keys. BloxBot does that for you: install it, turn on one setting in Studio, and start building. Free models work out of the box, and because it's open source, you can see exactly what it does in your place.

## Features

- **Any model:** free models, your own API key, or OAuth. You can also use your Claude plan through your own Claude Code login, at your own risk.
- **Explorer:** browse even very large places, edit properties, attributes and tags by hand, and drag any object into your message.
- **Instructions:** tell BloxBot what to keep in mind in every chat.
- **Notifications:** get a ping when a chat finishes or needs you, while you work in Studio.

## Get started

1. [Download BloxBot](https://github.com/paralov/app-bloxbot-ai/releases/latest) for macOS, Windows or Debian/Ubuntu.
2. Open a place in Roblox Studio.
3. In Studio, open **Assistant** settings (three-dot menu) → **MCP Servers** and turn on **Studio as MCP server**.
4. Open BloxBot and start building. Add your own models any time in Settings → Providers.

On Windows, SmartScreen may warn about a new release. Click "More info", then "Run anyway".

## Contributing

Bug reports and pull requests are welcome. For anything big, [open an issue](https://github.com/paralov/app-bloxbot-ai/issues) first so we can talk it through.

You'll need [Node.js](https://nodejs.org/) 22+ and [pnpm](https://pnpm.io/) 10+.

```sh
pnpm install
pnpm dev
```

Before opening a pull request, run `pnpm test`, `pnpm typecheck` and `pnpm lint`, and add anything users will notice to the [changelog](CHANGELOG.md).

## Built on

[OpenCode](https://opencode.ai) runs the AI, and [Roblox Studio MCP](https://create.roblox.com/docs/studio/mcp) connects it to Studio.

## License

[MIT](LICENSE)
