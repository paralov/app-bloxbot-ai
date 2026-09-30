import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Effect, Either, Logger, LogLevel } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  findOpenCodeListeningPort,
  trackOpenCodeOutput,
  waitForListeningPort,
  withOutputTail,
} from "../../electron/services/OpenCode";

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

describe("OpenCode startup output", () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const startNode = (script: string) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
    children.push(child);
    return { child, output: trackOpenCodeOutput(child) };
  };

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  it("includes the end of stderr when OpenCode exits during startup", async () => {
    const { child, output } = startNode(
      "process.stderr.write('\\u001b[31mError: database is locked\\u001b[0m\\n'); process.exit(3)",
    );

    const result = await Effect.runPromise(
      Effect.either(waitForListeningPort(child, output, "20 seconds")).pipe(
        Logger.withMinimumLogLevel(LogLevel.None),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        message: "OpenCode exited during startup with code 3. Output: Error: database is locked",
      },
    });
  });

  it("includes a bounded end of stderr when OpenCode never opens a port", async () => {
    const { child, output } = startNode(
      "process.stderr.write('x'.repeat(5000) + ' waiting on migration\\n'); setInterval(() => {}, 1000)",
    );
    await new Promise<void>((resolve) => child.stderr.once("data", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const result = await Effect.runPromise(
      Effect.either(waitForListeningPort(child, output, "1 second")).pipe(
        Logger.withMinimumLogLevel(LogLevel.None),
      ),
    );

    const message = Either.isLeft(result) ? result.left.message : "";
    expect(message).toMatch(
      /^OpenCode did not open a listening port within 1 seconds\. Output: x+ waiting on migration$/,
    );
    expect(message.length).toBeLessThan(500);
    expect(output.stderr().length).toBeLessThanOrEqual(2048);
  });

  it("falls back to stdout and leaves the message alone when there is no output", () => {
    const output = {
      stderr: () => " \n",
      stdout: () => "listening\nready\n",
      closed: Promise.resolve(),
    };
    expect(withOutputTail("OpenCode exited", output)).toBe(
      "OpenCode exited. Output: listening ready",
    );
    expect(withOutputTail("OpenCode exited", { ...output, stdout: () => "" })).toBe(
      "OpenCode exited",
    );
  });
});
