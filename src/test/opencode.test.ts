import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either, Logger, LogLevel } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  explainNetstatMiss,
  findOpenCodeListeningPort,
  parseListeningPort,
  trackOpenCodeOutput,
  waitForHealth,
  waitForListeningPort,
  withOutputTail,
} from "../../electron/services/OpenCode";
import { parseShellEnv } from "../../electron/shellEnv";

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
      /^OpenCode did not open a listening port within 1 seconds\. .* Output: x+ waiting on migration$/,
    );
    expect(message.length).toBeLessThan(800);
    expect(output.stderr().length).toBeLessThanOrEqual(2048);
  });

  it("falls back to stdout and leaves the message alone when there is no output", () => {
    const output = {
      stderr: () => " \n",
      stdout: () => "listening\nready\n",
    };
    expect(withOutputTail("OpenCode exited", output)).toBe(
      "OpenCode exited. Output: listening ready",
    );
    expect(withOutputTail("OpenCode exited", { ...output, stdout: () => "" })).toBe(
      "OpenCode exited",
    );
  });
});

describe("finding OpenCode's port", () => {
  const PID = 1234;
  const LINE = "server listening on http://127.0.0.1:51078";
  const listener = {
    localAddress: "127.0.0.1",
    localPort: "54321",
    pid: PID,
    protocol: "tcp",
    state: "LISTEN",
  };
  const never = () => new Promise<never>(() => {});
  const noProbe = { probe: async () => null };

  /** A child whose streams and exit are driven by the test, one exact chunk at a time. */
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: PID,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const typed = child as unknown as ChildProcessWithoutNullStreams;
    return { child, typed, output: trackOpenCodeOutput(typed) };
  };
  const quietly = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.either(effect).pipe(Logger.withMinimumLogLevel(LogLevel.None)));
  const isPending = async (promise: Promise<unknown>) => {
    const pending = Symbol();
    await new Promise((resolve) => setImmediate(resolve));
    return (await Promise.race([promise, Promise.resolve(pending)])) === pending;
  };

  it.each([
    [LINE, 51078],
    [`${LINE}/`, 51078],
    [`${LINE}\r`, 51078],
    [`\u001b[32m${LINE}\u001b[0m`, 51078],
    [`opencode ${LINE}`, 51078],
  ])("reads the port from %j", (line, port) => {
    expect(parseListeningPort(line)).toBe(port);
  });

  it.each([
    "server listening on http://0.0.0.0:4096",
    "server listening on http://192.168.1.20:4096",
    "server listening on http://example.com:4096",
    "server listening on http://127.0.0.1.example.com:4096",
    "server listening on http://127.0.0.1:4096@example.com",
    "server listening on http://127.0.0.1:4096/path",
    "server listening on https://127.0.0.1:4096",
    "server listening on http://127.0.0.1:0",
    "server listening on http://127.0.0.1:70000",
    "server listening on http://127.0.0.1",
    "listening on http://127.0.0.1:4096",
    "Error: could not connect to http://127.0.0.1:4096",
  ])("rejects %j", (line) => {
    expect(parseListeningPort(line)).toBeNull();
  });

  it("waits for the whole line when a chunk ends in the middle of the port", async () => {
    const { child, output } = fakeChild();

    child.stdout.emit("data", Buffer.from("server listening on http://127.0.0.1:510"));
    expect(await isPending(output.announcedPort)).toBe(true);

    child.stdout.emit("data", Buffer.from("78\r\n"));
    await expect(output.announcedPort).resolves.toBe(51078);
  });

  it("reads a last line with no newline once the output pauses, as Windows can leave it", async () => {
    const { child, output } = fakeChild();

    child.stdout.emit("data", Buffer.from(LINE));
    expect(await isPending(output.announcedPort)).toBe(true);

    await expect(output.announcedPort).resolves.toBe(51078);
  });

  it("splits lines on a lone carriage return too", async () => {
    const { child, output } = fakeChild();

    child.stdout.emit("data", Buffer.from(`starting\r${LINE}\rmore`));
    await expect(output.announcedPort).resolves.toBe(51078);
  });

  it("keeps stdout and stderr lines apart when their chunks interleave", async () => {
    const { child, output } = fakeChild();

    child.stdout.emit("data", Buffer.from("server listening on http:"));
    child.stderr.emit("data", Buffer.from("a warning\n"));
    child.stdout.emit("data", Buffer.from("//127.0.0.1:51078\n"));

    await expect(output.announcedPort).resolves.toBe(51078);
  });

  it("finds the port on stderr, and after more output than the tail keeps", async () => {
    const { child, output } = fakeChild();

    child.stderr.emit("data", Buffer.from(`${"noise ".repeat(2000)}\n${LINE}\n`));
    child.stderr.emit("data", Buffer.from(`${"noise\n".repeat(2000)}`));

    await expect(output.announcedPort).resolves.toBe(51078);
    expect(output.stderr()).not.toContain(LINE);
  });

  it("uses the port from the output when netstat returns nothing", async () => {
    const { child, typed, output } = fakeChild();
    const connections = vi.fn(async () => []);
    child.stdout.emit("data", Buffer.from(`${LINE}\n`));

    const result = await quietly(
      waitForListeningPort(typed, output, "20 seconds", { connections, ...noProbe }),
    );

    expect(result).toEqual(Either.right(51078));
  });

  it("uses the port from the output when netstat never comes back", async () => {
    const { child, typed, output } = fakeChild();
    const run = quietly(
      waitForListeningPort(typed, output, "20 seconds", { connections: never, ...noProbe }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.emit("data", Buffer.from(`${LINE}\n`));

    expect(await run).toEqual(Either.right(51078));
  });

  it("falls back to netstat when the output never names the port", async () => {
    const { typed, output } = fakeChild();

    const result = await quietly(
      waitForListeningPort(typed, output, "20 seconds", {
        connections: async () => [listener],
        ...noProbe,
      }),
    );

    expect(result).toEqual(Either.right(54321));
  });

  it("doesn't let an ambiguous netstat answer end startup before the output arrives", async () => {
    const { child, typed, output } = fakeChild();
    const run = quietly(
      waitForListeningPort(typed, output, "20 seconds", {
        connections: async () => [listener, { ...listener, localPort: "54322" }],
        ...noProbe,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.stdout.emit("data", Buffer.from(`${LINE}\n`));

    expect(await run).toEqual(Either.right(51078));
  });

  it("reports an exit straight away even though netstat never comes back", async () => {
    const { child, typed, output } = fakeChild();
    const run = quietly(
      waitForListeningPort(typed, output, "20 seconds", { connections: never, ...noProbe }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    child.exitCode = 7;
    child.emit("exit");
    child.emit("close");

    expect(await run).toMatchObject({
      left: { message: "OpenCode exited during startup with code 7" },
    });
  });

  it("doesn't take a non-loopback address, and says what netstat saw at the timeout", async () => {
    const { child, typed, output } = fakeChild();
    child.stdout.emit("data", Buffer.from("server listening on http://0.0.0.0:51078\n"));

    const result = await quietly(
      waitForListeningPort(typed, output, "100 millis", {
        connections: async () => [
          { ...listener, localAddress: "0.0.0.0" },
          { ...listener, localAddress: "192.168.1.20", localPort: "9000" },
          { ...listener, pid: 999 },
          { ...listener, pid: 999, state: "ESTABLISHED" },
          { ...listener, state: "ESTABLISHED" },
        ],
        ...noProbe,
      }),
    );

    expect(Either.isLeft(result) ? result.left.message : "").toBe(
      "OpenCode did not open a listening port within 0 seconds. No port in its output, " +
        "netstat 1 of 1 calls returned, last 5 rows, 3 listening, 3 for pid 1234, " +
        "its listeners 0.0.0.0:54321 other:9000. " +
        "Output: server listening on http://0.0.0.0:51078",
    );
  });

  it("says netstat came back empty", async () => {
    const { typed, output } = fakeChild();
    const probe = vi.fn(async () => "should not run");

    const result = await quietly(
      waitForListeningPort(typed, output, "100 millis", { connections: async () => [], probe }),
    );

    expect(Either.isLeft(result) ? result.left.message : "").toBe(
      "OpenCode did not open a listening port within 0 seconds. No port in its output, " +
        "netstat 1 of 1 calls returned, last 0 rows, 0 listening, 0 for pid 1234, its listeners none",
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("asks netstat directly when the lookup never comes back, and says why it failed", async () => {
    const { typed, output } = fakeChild();
    const probe = vi.fn(async () => "failed with 1: 'netstat' is not recognized");

    const result = await quietly(
      waitForListeningPort(typed, output, "100 millis", { connections: never, probe }),
    );

    expect(Either.isLeft(result) ? result.left.message : "").toBe(
      "OpenCode did not open a listening port within 0 seconds. No port in its output, " +
        "netstat 0 of 1 calls returned, direct netstat failed with 1: 'netstat' is not recognized",
    );
    expect(probe).toHaveBeenCalledWith(PID);
  });

  describe("explaining a netstat miss once OpenCode is up", () => {
    const row = { ...listener, localPort: "51078" };
    const explain = (connections: () => Promise<(typeof row)[]>, probe = noProbe.probe) =>
      Effect.runPromise(explainNetstatMiss(PID, 51078, { connections, probe }, "100 millis"));

    it("stays quiet when netstat shows the port under the spawned pid", async () => {
      expect(await explain(async () => [row])).toBeNull();
    });

    it("names the pid that holds the port when it isn't the spawned one", async () => {
      expect(await explain(async () => [{ ...row, pid: 999 }])).toBe(
        "OpenCode is on port 51078 but netstat doesn't show it for pid 1234: " +
          "netstat 1 of 1 calls returned, last 1 rows, 1 listening, 0 for pid 1234, " +
          "its listeners none, port held by 999",
      );
    });

    it("says when netstat returned no rows", async () => {
      expect(await explain(async () => [])).toBe(
        "OpenCode is on port 51078 but netstat doesn't show it for pid 1234: " +
          "netstat 1 of 1 calls returned, last 0 rows, 0 listening, 0 for pid 1234, " +
          "its listeners none, port held by nobody",
      );
    });

    it("asks netstat directly when the lookup never comes back", async () => {
      expect(await explain(never, async () => "failed with 1: not recognized")).toBe(
        "OpenCode is on port 51078 but netstat doesn't show it for pid 1234: " +
          "netstat 0 of 1 calls returned, direct netstat failed with 1: not recognized, " +
          "port held by nobody",
      );
    });
  });

  it("names the port and the last response when the health check never passes", async () => {
    const { typed, output } = fakeChild();
    const server = createServer((_request, response) => {
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const unauthorized = await quietly(
      waitForHealth(typed, output, port, "Basic c2VjcmV0", "1 second"),
    );
    await new Promise((resolve) => server.close(resolve));
    const refused = await quietly(waitForHealth(typed, output, port, "Basic c2VjcmV0", "1 second"));

    expect(Either.isLeft(unauthorized) ? unauthorized.left.message : "").toBe(
      `OpenCode did not become healthy on port ${port} within 1 seconds. Last check: HTTP 401`,
    );
    expect(Either.isLeft(refused) ? refused.left.message : "").toBe(
      `OpenCode did not become healthy on port ${port} within 1 seconds. Last check: ECONNREFUSED`,
    );
  });
});

// Run against a real binary, this catches OpenCode changing the line that startup relies on:
//   OPENCODE_LIVE_BIN=/path/to/opencode pnpm vitest run src/test/opencode.test.ts
describe.skipIf(!process.env.OPENCODE_LIVE_BIN)("a real OpenCode server", () => {
  it("is found from its output alone and passes the health check", async () => {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-opencode-port-"));
    const password = "port-test";
    const child = spawn(
      process.env.OPENCODE_LIVE_BIN as string,
      ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      {
        cwd: home,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CACHE_HOME: join(home, "cache"),
          OPENCODE_PASSWORD: password,
        },
        stdio: "pipe",
      },
    );
    try {
      const output = trackOpenCodeOutput(child);
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      const result = await Effect.runPromise(
        waitForListeningPort(child, output, "60 seconds", {
          connections: async () => [],
          probe: async () => null,
        }).pipe(
          Effect.tap((port) => waitForHealth(child, output, port, authorization, "60 seconds")),
          Effect.either,
          Logger.withMinimumLogLevel(LogLevel.None),
        ),
      );
      expect(result).toEqual(Either.right(expect.any(Number)));
    } finally {
      child.kill("SIGKILL");
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 130_000);
});

describe("the shell environment", () => {
  it("reads the output of env -0, including values with = and newlines", () => {
    expect(parseShellEnv("Welcome!\nPATH=/a:/b\0NOTE=x=y\nz\0\0broken\0")).toEqual({
      PATH: "/a:/b",
      NOTE: "x=y\nz",
    });
  });
});
