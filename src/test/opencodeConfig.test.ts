import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompt";
import {
  createOpenCodeConfig,
  studioMcpCommand,
  withSystemPrompt,
} from "../../electron/opencodeConfig";

const broker = { url: "http://127.0.0.1:43210/mcp" };

describe("Studio MCP command", () => {
  it("resolves cmd.exe through ComSpec instead of PATH on Windows", () => {
    expect(
      studioMcpCommand("win32", {
        localAppData: "C:\\Users\\User\\AppData\\Local",
        comSpec: "C:\\WINDOWS\\system32\\cmd.exe",
      }),
    ).toEqual([
      "C:\\WINDOWS\\system32\\cmd.exe",
      "/c",
      "C:\\Users\\User\\AppData\\Local\\Roblox\\mcp.bat",
    ]);
  });

  it("falls back to SystemRoot, then C:\\Windows, when ComSpec is missing", () => {
    expect(studioMcpCommand("win32", { systemRoot: "D:\\Windows" })[0]).toBe(
      "D:\\Windows\\System32\\cmd.exe",
    );
    expect(studioMcpCommand("win32")[0]).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

describe("OpenCode configuration", () => {
  it("does not install third-party authentication plugins by default", () => {
    expect(createOpenCodeConfig(broker)).not.toHaveProperty("plugin");
  });
});

describe("system prompt", () => {
  it("uses the default until the user has written their own", () => {
    expect(createOpenCodeConfig(broker).agents.studio.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(createOpenCodeConfig(broker, null).agents.studio.system).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(createOpenCodeConfig(broker, "Be brief.").agents.studio.system).toBe("Be brief.");
  });

  it("swaps only the prompt in a written config, and resets it", () => {
    const written = JSON.stringify(createOpenCodeConfig(broker));
    const custom = JSON.parse(withSystemPrompt(written, "Be brief."));
    expect(custom.agents.studio.system).toBe("Be brief.");
    expect(custom.mcp.servers["roblox-studio"].url).toBe(broker.url);

    const reset = JSON.parse(withSystemPrompt(JSON.stringify(custom), null));
    expect(reset.agents.studio.system).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
