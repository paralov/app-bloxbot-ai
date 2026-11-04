import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompt";
import {
  createOpenCodeConfig,
  studioMcpCommand,
  withBlender,
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

  describe("Blender", () => {
    const server = { type: "local" as const, command: ["/blender-mcp"], environment: { A: "1" } };

    it("isn't there until it's set up", () => {
      const config = createOpenCodeConfig(broker);
      expect(Object.keys(config.mcp.servers)).not.toContain("blender");
      expect(config.agents.studio.system).toBe(DEFAULT_SYSTEM_PROMPT);
    });

    it("adds the server and what the agent has to know, whatever the system prompt is", () => {
      const config = createOpenCodeConfig(broker, "Be brief.", server);
      expect(config.mcp.servers).toHaveProperty("blender", server);
      expect(config.agents.studio.system).toMatch(/^Be brief\./);
      expect(config.agents.studio.system).toMatch(/Never upload it/);
      expect(config.agents.studio.system).toMatch(/refuse extremist/);
    });

    it("applies being set up and removed to a config already written", () => {
      const written = JSON.stringify(createOpenCodeConfig(broker, "Be brief."));

      const added = JSON.parse(withBlender(written, server, "Be brief."));
      expect(added.mcp.servers.blender).toEqual(server);
      expect(added.agents.studio.system).toMatch(/Never upload it/);

      const removed = JSON.parse(withBlender(JSON.stringify(added), null, "Be brief."));
      expect(removed.mcp.servers).not.toHaveProperty("blender");
      expect(removed.agents.studio.system).toBe("Be brief.");
    });

    it("keeps what the agent has to know when the system prompt changes", () => {
      const written = JSON.stringify(createOpenCodeConfig(broker, null, server));
      const changed = JSON.parse(withSystemPrompt(written, "Be brief."));
      expect(changed.agents.studio.system).toMatch(/^Be brief\./);
      expect(changed.agents.studio.system).toMatch(/Never upload it/);
    });
  });
});

describe("uploads the AI can't make by itself", () => {
  it("asks before Studio's upload_image tool sends anything to Roblox, with or without Blender", () => {
    for (const blender of [
      null,
      { type: "local" as const, command: ["blender-mcp"], environment: {} },
    ]) {
      const { permissions } = createOpenCodeConfig({ url: "http://127.0.0.1:1" }, null, blender);
      expect(permissions).toEqual(
        expect.arrayContaining([
          { action: "roblox-studio_upload_image", resource: "*", effect: "ask" },
          { action: "roblox_studio_upload_image", resource: "*", effect: "ask" },
        ]),
      );
    }
  });

  it("tells the AI to use FBX and never to handle a key", () => {
    const blender = { type: "local" as const, command: ["blender-mcp"], environment: {} };
    const { system } = createOpenCodeConfig({ url: "http://127.0.0.1:1" }, null, blender).agents
      .studio;
    expect(system).toContain("export FBX");
    expect(system).not.toContain("GLB");
    expect(system).toContain("never ask for a Roblox API key");
  });
});
