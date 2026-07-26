import { describe, expect, it } from "vitest";

import { createOpenCodeConfig } from "../../electron/opencodeConfig";

describe("OpenCode configuration", () => {
  it("does not install third-party authentication plugins by default", () => {
    expect(createOpenCodeConfig("darwin")).not.toHaveProperty("plugin");
  });

  it("keeps automatic context compaction enabled", () => {
    expect(createOpenCodeConfig("darwin").compaction).toEqual({ auto: true });
  });

  it("keeps Studio instructions concise and action-oriented", () => {
    const prompt = createOpenCodeConfig("darwin").agent.studio.prompt;

    expect(prompt.trim().split(/\s+/).length).toBeLessThanOrEqual(55);
    expect(prompt).toMatch(/inspect .* before editing/i);
    expect(prompt).toContain("smallest coherent change");
    expect(prompt).toContain("most relevant Studio check");
    expect(prompt).toContain("stop retrying");
  });

  it("registers a disabled Studio router template for per-session pinning", () => {
    const config = createOpenCodeConfig("darwin", undefined, {
      executable: "/Applications/BloxBot.app/Contents/MacOS/BloxBot",
      script:
        "/Applications/BloxBot.app/Contents/Resources/app.asar/dist-electron/studio-router/studioMcpRouter.js",
    });

    expect(config.mcp["bloxbot-studio-router-template"]).toEqual({
      type: "local",
      command: [
        "/Applications/BloxBot.app/Contents/MacOS/BloxBot",
        "/Applications/BloxBot.app/Contents/Resources/app.asar/dist-electron/studio-router/studioMcpRouter.js",
      ],
      environment: {
        BLOXBOT_STUDIO_ROUTER_ENTRY: "1",
        ELECTRON_RUN_AS_NODE: "1",
      },
      enabled: false,
    });
  });
});
