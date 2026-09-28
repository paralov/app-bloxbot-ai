import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Context, Duration, Effect, Fiber, Layer, Schedule, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioMcpUpstream } from "../../electron/services/StudioMcpBroker";
import {
  describeConnectFailure,
  makeStudioMcpBrokerLayer,
  runStudioMcpStartup,
  StudioMcpBroker,
  StudioMcpBrokerError,
  StudioMcpConnectError,
  StudioMcpConnection,
  StudioMcpNotInstalledError,
  startStudioMcpBroker,
  studioMcpStartSchedule,
} from "../../electron/services/StudioMcpBroker";
import { nodeStudioMcpHelperProbe } from "../../electron/studioMcpHelper";
import { describeError } from "../lib/errorReporting";

const tools: Tool[] = [
  {
    name: "inspect_place",
    description: "Read the place",
    inputSchema: { type: "object", properties: { depth: { type: "number" } } },
  },
];

function fakeUpstream(overrides: Partial<StudioMcpUpstream> = {}): StudioMcpUpstream {
  return {
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    onToolsChanged: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function connect(info: { url: string }) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(info.url));
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe("Studio MCP broker", () => {
  it("binds the OpenCode adapter to loopback", async () => {
    const broker = await startStudioMcpBroker(fakeUpstream());
    cleanups.push(() => broker.close());

    expect(broker.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it("forwards tool discovery and calls over standard MCP transport", async () => {
    const upstream = fakeUpstream();
    const broker = await startStudioMcpBroker(upstream);
    cleanups.push(() => broker.close());
    const client = await connect(broker.info);

    await expect(client.listTools()).resolves.toEqual({ tools });
    await expect(
      client.callTool({ name: "inspect_place", arguments: { depth: 3 } }),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(upstream.callTool).toHaveBeenCalledWith("inspect_place", { depth: 3 });
  });

  it("keeps concurrent clients stateless by forwarding each explicit studio_id", async () => {
    const upstream = fakeUpstream();
    const broker = await startStudioMcpBroker(upstream);
    cleanups.push(() => broker.close());
    const [firstClient, secondClient] = await Promise.all([
      connect(broker.info),
      connect(broker.info),
    ]);

    await Promise.all([
      firstClient.callTool({
        name: "inspect_place",
        arguments: { studio_id: "studio-one", depth: 2 },
      }),
      secondClient.callTool({
        name: "inspect_place",
        arguments: { studio_id: "studio-two", depth: 4 },
      }),
    ]);

    expect(upstream.callTool).toHaveBeenCalledWith("inspect_place", {
      studio_id: "studio-one",
      depth: 2,
    });
    expect(upstream.callTool).toHaveBeenCalledWith("inspect_place", {
      studio_id: "studio-two",
      depth: 4,
    });
  });

  it("closes the single upstream Studio client", async () => {
    const upstream = fakeUpstream();
    const broker = await startStudioMcpBroker(upstream);

    await broker.close();
    expect(upstream.close).toHaveBeenCalledOnce();
  });

  it("creates the workspace directory before spawning the upstream (#76)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bloxbot-test-"));
    const workspace = join(tmp, "nested", "BloxBot");
    try {
      const layer = makeStudioMcpBrokerLayer({ workspace, platform: "linux" });
      await Effect.runPromise(Effect.scoped(Layer.build(layer)));
      expect(existsSync(workspace)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

const closed = () =>
  new StudioMcpConnectError({
    message:
      "MCP error -32000: Connection closed (exit code 1, stderr: The system cannot find the path specified.)",
    cause: new Error("MCP error -32000: Connection closed"),
  });

// Same retry count as the real schedule, without the waits.
const instantSchedule = Schedule.recurs(4);

describe("Studio MCP startup (#106)", () => {
  it("retries five times over 30 seconds, then reports once", async () => {
    const connectUpstream = vi.fn<() => Promise<StudioMcpUpstream>>().mockRejectedValue(closed());
    const connection = new StudioMcpConnection(connectUpstream);
    const onFailure = vi.fn();
    // Lets the rejected attempt settle before the test clock moves on.
    const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          runStudioMcpStartup(connection, { schedule: studioMcpStartSchedule, onFailure }),
        );
        yield* settle;
        expect(connectUpstream).toHaveBeenCalledTimes(1);
        for (const [delay, attempts] of [
          [2, 2],
          [4, 3],
          [8, 4],
        ] as const) {
          yield* TestClock.adjust(Duration.seconds(delay));
          yield* settle;
          expect(connectUpstream).toHaveBeenCalledTimes(attempts);
        }
        expect(connection.status()).toEqual({ state: "starting" });
        expect(onFailure).not.toHaveBeenCalled();
        yield* TestClock.adjust(Duration.seconds(16));
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(connectUpstream).toHaveBeenCalledTimes(5);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(connection.status()).toEqual({ state: "unavailable" });
  });

  it("recovers from a helper that closes during startup", async () => {
    const upstream = fakeUpstream();
    const connectUpstream = vi
      .fn<() => Promise<StudioMcpUpstream>>()
      .mockRejectedValueOnce(closed())
      .mockRejectedValueOnce(closed())
      .mockResolvedValue(upstream);
    const connection = new StudioMcpConnection(connectUpstream);
    const onFailure = vi.fn();

    expect(connection.status()).toEqual({ state: "starting" });
    await Effect.runPromise(
      runStudioMcpStartup(connection, { schedule: instantSchedule, onFailure }),
    );

    expect(connectUpstream).toHaveBeenCalledTimes(3);
    expect(connection.status()).toEqual({ state: "connected" });
    expect(onFailure).not.toHaveBeenCalled();
    await expect(connection.listTools()).resolves.toEqual({ tools });
  });

  it("reports once with the helper's output when every attempt closes", async () => {
    const connectUpstream = vi.fn<() => Promise<StudioMcpUpstream>>().mockRejectedValue(closed());
    const connection = new StudioMcpConnection(connectUpstream);
    const onFailure = vi.fn();

    await Effect.runPromise(
      runStudioMcpStartup(connection, { schedule: instantSchedule, onFailure }),
    );

    expect(connectUpstream).toHaveBeenCalledTimes(5);
    expect(connection.status()).toEqual({ state: "unavailable" });
    expect(onFailure).toHaveBeenCalledOnce();
    const reported = onFailure.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(StudioMcpBrokerError);
    expect(describeError(reported).message).toBe(
      "Failed to connect to Studio MCP at startup (cause: MCP error -32000: Connection closed (exit code 1, stderr: The system cannot find the path specified.))",
    );
  });

  it("doesn't retry or report when Studio isn't installed", async () => {
    const connectUpstream = vi
      .fn<() => Promise<StudioMcpUpstream>>()
      .mockRejectedValue(
        new StudioMcpNotInstalledError({ message: "Studio MCP helper not found" }),
      );
    const connection = new StudioMcpConnection(connectUpstream);
    const onFailure = vi.fn();

    await Effect.runPromise(
      runStudioMcpStartup(connection, { schedule: instantSchedule, onFailure }),
    );

    expect(connectUpstream).toHaveBeenCalledOnce();
    expect(connection.status()).toEqual({ state: "not_installed" });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the app usable and reports Studio isn't installed when the helper is missing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "bloxbot-test-"));
    const onStartFailure = vi.fn();
    try {
      const status = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              makeStudioMcpBrokerLayer({
                workspace: join(tmp, "BloxBot"),
                // No Roblox\mcp.bat under this LOCALAPPDATA, as on a PC without Studio.
                platform: "win32",
                localAppData: tmp,
                // No Studio registry entry either, even when the tests run on a PC with Studio.
                helperProbe: { ...nodeStudioMcpHelperProbe, queryContentFolder: async () => null },
                onStartFailure,
                startSchedule: instantSchedule,
              }),
            );
            const broker = Context.get(context, StudioMcpBroker);
            expect(broker.info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
            yield* Effect.promise(() =>
              vi.waitFor(async () => {
                const current = await Effect.runPromise(broker.status);
                if (current.state === "starting") throw new Error("still starting");
              }),
            );
            return yield* broker.status;
          }),
        ),
      );
      expect(status).toEqual({ state: "not_installed" });
      expect(onStartFailure).not.toHaveBeenCalled();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses new sessions until Studio connects, then reconnects on demand", async () => {
    let now = 0;
    const upstream = fakeUpstream();
    const connectUpstream = vi
      .fn<() => Promise<StudioMcpUpstream>>()
      .mockRejectedValueOnce(closed())
      .mockResolvedValue(upstream);
    const connection = new StudioMcpConnection(connectUpstream, {
      reconnectIntervalMs: 5_000,
      now: () => now,
    });
    await Effect.runPromise(runStudioMcpStartup(connection, { schedule: Schedule.stop }));
    expect(connection.status()).toEqual({ state: "unavailable" });

    const broker = await startStudioMcpBroker(connection);
    cleanups.push(() => broker.close());

    // Too soon after the last attempt: no new helper is spawned.
    await expect(connect(broker.info)).rejects.toThrow(/503|not available/);
    expect(connectUpstream).toHaveBeenCalledOnce();

    now = 5_000;
    const client = await connect(broker.info);
    expect(connectUpstream).toHaveBeenCalledTimes(2);
    expect(connection.status()).toEqual({ state: "connected" });
    await expect(client.listTools()).resolves.toEqual({ tools });
    await expect(Effect.runPromise(broker.status)).resolves.toEqual({ state: "connected" });
  });

  it("reconnects when the helper closes after connecting", async () => {
    let closeListener: (() => void) | undefined;
    const first = fakeUpstream({
      onClose: (listener) => {
        closeListener = listener;
      },
    });
    const second = fakeUpstream();
    const connectUpstream = vi
      .fn<() => Promise<StudioMcpUpstream>>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const connection = new StudioMcpConnection(connectUpstream, { reconnectIntervalMs: 0 });
    await Effect.runPromise(runStudioMcpStartup(connection));

    closeListener?.();
    expect(connection.status()).toEqual({ state: "unavailable" });
    await connection.callTool("inspect_place", {});

    expect(second.callTool).toHaveBeenCalledWith("inspect_place", {});
    expect(connection.status()).toEqual({ state: "connected" });
  });

  it("describes a closed helper with its exit status and stderr", () => {
    expect(
      describeConnectFailure(
        new Error("MCP error -32000: Connection closed"),
        { code: 1, signal: null },
        "\nThe system cannot find\n the path specified.\n",
      ),
    ).toBe(
      "MCP error -32000: Connection closed (exit code 1, stderr: The system cannot find the path specified.)",
    );
    expect(describeConnectFailure(new Error("boom"), undefined, "")).toBe("boom");
  });

  it("says how the Windows helper was found, without its path", () => {
    expect(
      describeConnectFailure(
        new Error("MCP error -32000: Connection closed"),
        { code: 1, signal: null },
        "",
        "registry",
      ),
    ).toBe("MCP error -32000: Connection closed (helper_source: registry, exit code 1)");
  });
});
