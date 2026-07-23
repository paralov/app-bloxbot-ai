import { join } from "node:path";

function studioMcpCommand(platform: NodeJS.Platform, localAppData?: string): string[] {
  if (platform === "darwin") {
    return ["/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"];
  }

  if (platform === "win32") {
    const dataDirectory = localAppData ?? "C:\\Users\\Default\\AppData\\Local";
    return ["cmd.exe", "/c", join(dataDirectory, "Roblox", "mcp.bat")];
  }

  return ["studio-mcp"];
}

export function createOpenCodeConfig(platform: NodeJS.Platform, localAppData?: string) {
  return {
    // Keep OpenCode's standard automatic context compaction enabled for long sessions.
    compaction: {
      auto: true,
    },
    mcp: {
      "roblox-studio": {
        type: "local",
        command: studioMcpCommand(platform, localAppData),
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
          "Use Studio MCP directly. Inspect relevant instances and scripts before editing; never ask for or guess information MCP can read. Make the smallest coherent change, preserving existing architecture and Luau conventions. Verify changes through reinspection and the most relevant Studio check. Report briefly. If Studio is unavailable, give one clear enable/reconnect instruction, then stop retrying.",
      },
    },
  };
}
