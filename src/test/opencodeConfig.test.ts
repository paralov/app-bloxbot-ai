import { describe, expect, it } from "vitest";

import { createOpenCodeConfig } from "../../electron/opencodeConfig";

describe("OpenCode configuration", () => {
  it("keeps automatic context compaction enabled", () => {
    expect(createOpenCodeConfig("darwin").compaction).toEqual({ auto: true });
  });
});
