import { describe, expect, it } from "vitest";

import { parseOpenCodeListeningPort } from "../../electron/services/OpenCode";

describe("OpenCode server startup", () => {
  it("reads an OS-assigned loopback port from the startup message", () => {
    expect(
      parseOpenCodeListeningPort(
        "logs before\nopencode server listening on http://127.0.0.1:54321\n",
      ),
    ).toBe(54321);
  });

  it("rejects missing and invalid ports", () => {
    expect(parseOpenCodeListeningPort("starting")).toBeNull();
    expect(
      parseOpenCodeListeningPort("opencode server listening on http://127.0.0.1:70000"),
    ).toBeNull();
  });
});
