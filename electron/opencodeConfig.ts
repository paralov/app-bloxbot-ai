import { win32 } from "node:path";

export interface StudioMcpWindowsEnvironment {
  localAppData?: string;
  comSpec?: string;
  systemRoot?: string;
}

export function studioMcpCommand(
  platform: NodeJS.Platform,
  environment: StudioMcpWindowsEnvironment = {},
): string[] {
  if (platform === "darwin") {
    return ["/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"];
  }

  if (platform === "win32") {
    const dataDirectory = environment.localAppData ?? "C:\\Users\\Default\\AppData\\Local";
    // Resolve cmd.exe absolutely: the MCP stdio transport spawns with a reduced
    // environment, so a PATH without System32 makes a bare "cmd.exe" fail with ENOENT.
    const systemRoot = environment.systemRoot ?? "C:\\Windows";
    const comSpec = environment.comSpec ?? win32.join(systemRoot, "System32", "cmd.exe");
    return [comSpec, "/c", win32.join(dataDirectory, "Roblox", "mcp.bat")];
  }

  return ["studio-mcp"];
}

export function createOpenCodeConfig(broker: { url: string }) {
  return {
    // Keep OpenCode's standard automatic context compaction enabled for long sessions.
    compaction: {
      auto: true,
    },
    mcp: {
      "roblox-studio": {
        type: "remote",
        url: broker.url,
        enabled: true,
      },
    },
    default_agent: "studio",
    agent: {
      studio: {
        mode: "primary",
        description: "Roblox Studio development assistant",
        // OpenCode loads project AGENTS.md separately; keep this Studio-specific and compact.
        prompt:
          "Use Studio MCP directly. Inspect before editing; never guess what MCP can read. When multiple Studios are involved, discover them with the available MCP tools, clarify an ambiguous target, and select and verify it immediately before each place-specific action. Make the smallest coherent change, preserve Luau conventions, verify through reinspection and the most relevant Studio check, and report briefly. If Studio is unavailable, give one reconnect instruction, then stop retrying.",
      },
    },
  };
}
