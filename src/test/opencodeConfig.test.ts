import { describe, expect, it } from "vitest";

import { createOpenCodeConfig } from "../../electron/opencodeConfig";

describe("OpenCode configuration", () => {
  it("does not install third-party authentication plugins by default", () => {
    expect(createOpenCodeConfig("darwin")).not.toHaveProperty("plugin");
  });

  it("keeps automatic context compaction enabled", () => {
    expect(createOpenCodeConfig("darwin").compaction).toEqual({ auto: true });
  });
});
