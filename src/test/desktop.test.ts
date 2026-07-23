import { beforeEach, describe, expect, it, vi } from "vitest";

describe("browser desktop fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    delete window.bloxbot;
  });

  it("surfaces a useful error instead of waiting forever", async () => {
    const { desktop } = await import("@/lib/desktop");

    await expect(desktop.getOpenCodeInfo()).rejects.toThrow(
      "The desktop service is unavailable. Start BloxBot with pnpm dev.",
    );
  });

  it("reports Studio as disconnected outside Electron", async () => {
    const { desktop } = await import("@/lib/desktop");

    await expect(desktop.isStudioConnected()).resolves.toBe(false);
  });

  it("persists preferences while running as a web preview", async () => {
    const { desktop } = await import("@/lib/desktop");

    await desktop.patchConfig({ lastModel: "openai/gpt-5" });

    await expect(desktop.loadConfig()).resolves.toEqual({
      lastModel: "openai/gpt-5",
      hiddenModels: [],
      theme: "system",
      detailedAnalytics: "unset",
    });
  });

  it("rejects malformed persisted values through the config schema", async () => {
    window.localStorage.setItem(
      "bloxbot-config",
      JSON.stringify({ lastModel: 42, hiddenModels: "not-an-array" }),
    );
    const { desktop } = await import("@/lib/desktop");

    await expect(desktop.loadConfig()).resolves.toEqual({
      lastModel: null,
      hiddenModels: [],
      theme: "system",
      detailedAnalytics: "unset",
    });
  });

  it("persists the appearance theme preference", async () => {
    const { desktop } = await import("@/lib/desktop");

    await desktop.patchConfig({ theme: "dark" });

    await expect(desktop.loadConfig()).resolves.toEqual({
      lastModel: null,
      hiddenModels: [],
      theme: "dark",
      detailedAnalytics: "unset",
    });
  });

  it("persists detailed analytics consent separately from basic analytics", async () => {
    const { desktop } = await import("@/lib/desktop");

    await desktop.patchConfig({ detailedAnalytics: "enabled" });

    await expect(desktop.loadConfig()).resolves.toMatchObject({ detailedAnalytics: "enabled" });
  });
});
