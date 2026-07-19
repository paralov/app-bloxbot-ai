import { describe, expect, it } from "vitest";

import { findOpenCodeListeningPort } from "../../electron/services/OpenCode";

describe("OpenCode server startup", () => {
  const connection = {
    localAddress: "127.0.0.1",
    localPort: "54321",
    pid: 1234,
    protocol: "tcp4",
    state: "LISTEN",
  };

  it("finds the loopback TCP listener owned by the OpenCode process", () => {
    expect(findOpenCodeListeningPort([connection], 1234)).toBe(54321);
  });

  it("ignores connections that do not belong to the OpenCode listener", () => {
    expect(
      findOpenCodeListeningPort(
        [
          { ...connection, pid: 9999 },
          { ...connection, state: "ESTABLISHED" },
          { ...connection, localAddress: "0.0.0.0" },
        ],
        1234,
      ),
    ).toBeNull();
  });
});
