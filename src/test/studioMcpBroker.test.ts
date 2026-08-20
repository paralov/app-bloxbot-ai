import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioMcpUpstream } from "../../electron/services/StudioMcpBroker";
import {
  makeStudioMcpBrokerLayer,
  startStudioMcpBroker,
} from "../../electron/services/StudioMcpBroker";

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
      const result = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer)));
      // The spawn will fail because "studio-mcp" does not exist, but the
      // workspace directory must have been created before the spawn attempt.
      expect(result._tag).toBe("Failure");
      expect(existsSync(workspace)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
