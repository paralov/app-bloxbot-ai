import { describe, expect, it } from "vitest";

import { hasStudioMcpConnection } from "../../electron/services/StudioConnection";

const connection = (
  input: Partial<{
    localAddress: string;
    localPort: string;
    peerPort: string;
    process: string;
    protocol: string;
    state: string;
  }>,
) =>
  ({
    localAddress: "127.0.0.1",
    localPort: "0",
    peerPort: "0",
    process: "",
    protocol: "tcp4",
    state: "ESTABLISHED",
    ...input,
  }) as never;

describe("hasStudioMcpConnection", () => {
  const listener = connection({
    localPort: "13469",
    process: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
    state: "LISTEN",
  });

  it("detects Roblox Studio connected to the StudioMCP listener", () => {
    expect(
      hasStudioMcpConnection([
        listener,
        connection({
          localPort: "61234",
          peerPort: "13469",
          process: "/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio",
        }),
      ]),
    ).toBe(true);
  });

  it("supports the Windows Roblox Studio process name", () => {
    expect(
      hasStudioMcpConnection([
        connection({
          localPort: "13469",
          process: "C:\\Program Files\\Roblox\\StudioMCP.exe",
          state: "LISTENING",
        }),
        connection({
          localPort: "61234",
          peerPort: "13469",
          process: "C:\\Program Files\\Roblox\\RobloxStudioBeta.exe",
        }),
      ]),
    ).toBe(true);
  });

  it("does not mistake StudioMCP's internal proxy connection for Studio", () => {
    expect(
      hasStudioMcpConnection([
        listener,
        connection({
          localPort: "61234",
          peerPort: "13469",
          process: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
        }),
      ]),
    ).toBe(false);
  });
});
