import { describe, expect, it } from "vitest";

import { handleLastWindowClosed } from "../../electron/appLifecycle";

describe("app lifecycle", () => {
  it("hides the Dock icon before quitting on macOS", () => {
    const actions: string[] = [];

    handleLastWindowClosed("darwin", {
      hideDock: () => actions.push("hide Dock"),
      quit: () => actions.push("quit"),
    });

    expect(actions).toEqual(["hide Dock", "quit"]);
  });

  it.each([
    "linux",
    "win32",
  ] as const)("quits without trying to hide a Dock icon on %s", (platform) => {
    const actions: string[] = [];

    handleLastWindowClosed(platform, {
      hideDock: () => actions.push("hide Dock"),
      quit: () => actions.push("quit"),
    });

    expect(actions).toEqual(["quit"]);
  });
});
