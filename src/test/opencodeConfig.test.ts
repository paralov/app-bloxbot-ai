import { describe, expect, it } from "vitest";

import { createOpenCodeConfig, studioMcpCommand } from "../../electron/opencodeConfig";

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

  it("keeps the direct StudioMCP binary on macOS", () => {
    expect(studioMcpCommand("darwin")).toEqual([
      "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
    ]);
  });
});

describe("OpenCode configuration", () => {
  it("does not install third-party authentication plugins by default", () => {
    expect(createOpenCodeConfig(broker)).not.toHaveProperty("plugin");
  });

  it("keeps automatic context compaction enabled", () => {
    expect(createOpenCodeConfig(broker).compaction).toEqual({ auto: true });
  });

  it("keeps Studio instructions concise and action-oriented", () => {
    const prompt = createOpenCodeConfig(broker).agent.studio.prompt;

    expect(prompt.trim().split(/\s+/).length).toBeLessThanOrEqual(75);
    expect(prompt).toMatch(/inspect before editing/i);
    expect(prompt).toContain("smallest coherent change");
    expect(prompt).toContain("most relevant Studio check");
    expect(prompt).toContain("stop retrying");
    expect(prompt).toContain("pass studio_id");
    expect(prompt).toContain("never call set_active_studio");
  });

  it("connects OpenCode to the loopback broker", () => {
    expect(createOpenCodeConfig(broker).mcp["roblox-studio"]).toEqual({
      type: "remote",
      url: broker.url,
      enabled: true,
    });
  });
});
