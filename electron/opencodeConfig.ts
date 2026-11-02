import { win32 } from "node:path";

import { STUDIO_MCP_SERVER_NAME } from "../src/lib/bloxbotProgramManifest";
import { DEFAULT_SYSTEM_PROMPT } from "../src/lib/systemPrompt";

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

/**
 * The file Roblox Studio installs for its MCP helper, or null when the command is looked up
 * on PATH. When the file is missing, Studio isn't installed or hasn't set up MCP yet.
 */
export function studioMcpInstallPath(
  platform: NodeJS.Platform,
  environment: StudioMcpWindowsEnvironment = {},
): string | null {
  if (platform === "darwin" || platform === "win32") {
    return studioMcpCommand(platform, environment).at(-1) ?? null;
  }
  return null;
}

export function createOpenCodeConfig(broker: { url: string }, systemPrompt?: string | null) {
  return {
    // Keep OpenCode's standard automatic context compaction enabled for long sessions.
    compaction: {
      auto: true,
    },
    // The chat's task list. OpenCode 2 only offers the todo tool behind this flag.
    experimental: {
      todo: true,
    },
    mcp: {
      servers: {
        [STUDIO_MCP_SERVER_NAME]: {
          type: "remote",
          url: broker.url,
        },
      },
    },
    default_agent: "studio",
    agents: {
      studio: {
        mode: "primary",
        description: "Roblox Studio development assistant",
        system: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      },
    },
  };
}

/** The config with its system prompt swapped, for a change while OpenCode is running. */
export function withSystemPrompt(contents: string, systemPrompt: string | null): string {
  const config = JSON.parse(contents);
  config.agents.studio.system = systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  return JSON.stringify(config, null, 2);
}
