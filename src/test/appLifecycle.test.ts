import { describe, expect, it } from "vitest";

import { shouldQuitAfterLastWindowCloses } from "../../electron/appLifecycle";

describe("app lifecycle", () => {
  it("quits when the last development window closes on macOS", () => {
    expect(shouldQuitAfterLastWindowCloses("darwin", false)).toBe(true);
  });

  it("keeps the native macOS lifecycle for packaged builds", () => {
    expect(shouldQuitAfterLastWindowCloses("darwin", true)).toBe(false);
  });

  it("quits when the last window closes on other platforms", () => {
    expect(shouldQuitAfterLastWindowCloses("linux", true)).toBe(true);
    expect(shouldQuitAfterLastWindowCloses("win32", true)).toBe(true);
  });
});
