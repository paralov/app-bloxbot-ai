import { Effect } from "effect";
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
    expect(Effect.runSync(findOpenCodeListeningPort([connection], 1234))).toBe(54321);
  });

  it("ignores connections that do not belong to the OpenCode listener", () => {
    expect(
      Effect.runSync(
        findOpenCodeListeningPort(
          [
            { ...connection, pid: 9999 },
            { ...connection, state: "ESTABLISHED" },
            { ...connection, localAddress: "0.0.0.0" },
          ],
          1234,
        ),
      ),
    ).toBeNull();
  });

  it("fails with a typed Effect error when the process owns multiple listeners", () => {
    const result = Effect.runSync(
      Effect.either(
        findOpenCodeListeningPort([connection, { ...connection, localPort: "54322" }], 1234),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "OpenCodeError", message: expect.stringContaining("multiple loopback ports") },
    });
  });
});
