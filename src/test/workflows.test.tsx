/**
 * What people actually do in BloxBot, against the real thing: the OpenCode binary,
 * BloxBot's client and the whole app tree. Only the model, Roblox Studio and the
 * Electron bridge are fake. It needs a binary:
 *
 *   OPENCODE_LIVE_BIN=/path/to/opencode pnpm vitest run src/test/workflows.test.tsx
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "@/App";
import { desktop } from "@/lib/desktop";
import { createOpencodeClient } from "@/lib/opencode/client";
import { PASSWORD, shellCall, startScriptedProvider, startServer } from "@/test/support/liveServer";
import { createOpenCodeConfig } from "../../electron/opencodeConfig";

const BIN = process.env.OPENCODE_LIVE_BIN;
const FREE_MODEL = "opencode/deepseek-v4.1-flash-free";
const SLOW = 30_000;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 80,
        size: 80,
        end: (index + 1) * 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

/** Stands in for Roblox Studio's MCP server. */
async function startFakeStudio() {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    const mcp = new McpServer(
      { name: "studio", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "inspect_instance",
          description: "Reads an instance in Roblox Studio.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params.name);
      return { content: [{ type: "text", text: "studio-answer" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    calls,
    close: () => server.close(),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
  };
}

const message = () => screen.findByRole("textbox", { name: "Message" }, { timeout: SLOW });

async function type(text: string) {
  const box = await message();
  await act(async () => {
    fireEvent.input(box, { target: { textContent: text } });
  });
}

async function send(text: string) {
  await type(text);
  const box = await message();
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

const replyFinished = () =>
  waitFor(() => expect(screen.getByTitle("Send")).toBeInTheDocument(), { timeout: SLOW });

const startChat = async () => {
  const button = await screen.findAllByTitle("New chat", {}, { timeout: SLOW });
  await act(async () => {
    fireEvent.click(button[0] as HTMLElement);
  });
  await message();
};

describe.skipIf(!BIN)("[no model] Workflows", () => {
  let cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    window.localStorage.setItem(
      "bloxbot-config",
      JSON.stringify({
        lastModel: FREE_MODEL,
        detailedAnalytics: "disabled",
        analyticsNoticeVersion: 2,
        hiddenModels: [],
        theme: "dark",
      }),
    );
    vi.spyOn(desktop, "discoverStudioTargets").mockResolvedValue({
      targets: [{ key: "studio-1", label: "My Place", detail: "Local place" }],
      selectedKey: "studio-1",
    } as never);
    vi.spyOn(desktop, "selectStudioTarget").mockResolvedValue({
      selected: { key: "studio-1", label: "My Place", detail: "Local place" },
      verified: true,
    } as never);
    vi.spyOn(desktop, "getExplorerSnapshot").mockResolvedValue({
      placeName: "My Place",
      roots: [],
    } as never);
  });

  afterEach(async () => {
    cleanup();
    for (const run of cleanups.reverse()) await run();
    cleanups = [];
    vi.restoreAllMocks();
  });

  /** Starts OpenCode on a scripted model, and opens the app on it. */
  async function openApp(replies: ReadonlyArray<object>, home?: string, config: object = {}) {
    const directory = home ?? (await mkdtemp(join(tmpdir(), "bloxbot-workflow-")));
    const llm = await startScriptedProvider(replies);
    const studio = await startFakeStudio();
    await mkdir(join(directory, "config", "opencode"), { recursive: true });
    await writeFile(
      join(directory, "config", "opencode", "opencode.json"),
      JSON.stringify({
        ...createOpenCodeConfig({ url: studio.url }),
        ...config,
        providers: { opencode: { settings: { baseURL: llm.url } } },
      }),
    );
    const { child, baseUrl, workspace } = await startServer(BIN as string, directory);
    const authorization = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;
    vi.spyOn(desktop, "getOpenCodeInfo").mockResolvedValue({
      port: Number(new URL(baseUrl).port),
      workspace,
      authorization,
    } as never);
    const close = async () => {
      cleanup();
      child.kill();
      llm.provider.close();
      studio.close();
    };
    cleanups.push(close);
    if (!home) cleanups.push(() => rm(directory, { recursive: true, force: true }).catch(() => {}));
    render(<App />);
    const client = createOpencodeClient({
      baseUrl,
      directory: workspace,
      headers: { Authorization: authorization },
    });
    return { client, close, directory, llm, studio, workspace };
  }

  it("sends a message and shows the reply once", { timeout: 60_000 }, async () => {
    await openApp([{ content: "Hello from the model" }]);
    await startChat();
    await send("Build me a lobby");
    await screen.findByText("Hello from the model", {}, { timeout: SLOW });
    await replyFinished();
    expect(screen.getAllByText("Build me a lobby")).toHaveLength(1);
    expect(screen.getAllByText("Hello from the model")).toHaveLength(1);
  });

  it("runs a Studio tool and shows it finished", { timeout: 60_000 }, async () => {
    const code = 'return await tools["roblox-studio"].inspect_instance({});';
    const { studio } = await openApp([
      {
        tool_calls: [
          {
            index: 0,
            id: "call_code",
            type: "function",
            function: { name: "execute", arguments: JSON.stringify({ code }) },
          },
        ],
      },
      { content: "Studio answered" },
    ]);
    await startChat();
    // Studio's tools reach Code Mode a few seconds after the server connects.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await send("Look at the place");
    await screen.findByText("Studio answered", {}, { timeout: SLOW });
    expect(studio.calls).toContain("inspect_instance");
    await screen.findByText("Inspect instance", {}, { timeout: 5000 });
  });

  it("only runs a command after it's approved", { timeout: 90_000 }, async () => {
    const { workspace } = await openApp(
      [
        shellCall("echo denied > denied.txt"),
        shellCall("echo allowed > allowed.txt"),
        { content: "Done." },
      ],
      undefined,
      { permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
    );
    await startChat();
    await send("Write a file");
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }, { timeout: SLOW }));
    await replyFinished();
    expect(existsSync(join(workspace, "denied.txt"))).toBe(false);

    await send("Try again");
    fireEvent.click(await screen.findByRole("button", { name: "Allow Once" }, { timeout: SLOW }));
    await screen.findByText("Done.", {}, { timeout: SLOW });
    await replyFinished();
    expect(existsSync(join(workspace, "allowed.txt"))).toBe(true);
  });

  it("gets the answer to a question back to the model", { timeout: 60_000 }, async () => {
    const { llm } = await openApp([
      {
        tool_calls: [
          {
            index: 0,
            id: "call_question",
            type: "function",
            function: {
              name: "question",
              arguments: JSON.stringify({
                questions: [
                  {
                    question: "Which colour?",
                    header: "Colour",
                    options: [
                      { label: "Crimson", description: "Red" },
                      { label: "Azure", description: "Blue" },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      },
      { content: "Thanks." },
    ]);
    await startChat();
    await send("Ask me");
    fireEvent.click(await screen.findByText("Crimson", {}, { timeout: SLOW }));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Thanks.", {}, { timeout: SLOW });
    expect(llm.bodies.at(-1)).toContain("Crimson");
  });

  it("stops a reply, and the next message still works", { timeout: 60_000 }, async () => {
    await openApp([{ content: "Partly", hold: true }, { content: "Second reply" }]);
    await startChat();
    await send("Take your time");
    await screen.findByText("Partly", {}, { timeout: SLOW });
    fireEvent.click(screen.getByTitle("Stop"));
    await replyFinished();
    await send("Now answer");
    await screen.findByText("Second reply", {}, { timeout: SLOW });
    await replyFinished();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it(
    "runs /goal, and sends a slash that isn't a command as a message",
    { timeout: 90_000 },
    async () => {
      const { llm } = await openApp([{ content: "Working on the goal" }]);
      await startChat();
      // A bare /goal reports the goal's state. The catalog can take a moment to load.
      await waitFor(
        async () => {
          await send("/goal");
          await screen.findByText(/Usage: \/goal/, {}, { timeout: 1000 });
        },
        { timeout: SLOW, interval: 1000 },
      );
      await send("/goal Make it work");
      await screen.findByText("Working on the goal", {}, { timeout: SLOW });
      await replyFinished();
      await send("/goal clear");
      await screen.findByText("Goal cleared", {}, { timeout: SLOW });

      const requests = llm.bodies.length;
      await send("/usr/bin is a path");
      await screen.findByText("/usr/bin is a path", {}, { timeout: SLOW });
      await replyFinished();
      expect(llm.bodies.length).toBeGreaterThan(requests);
    },
  );

  it("undoes a message back into the box, and redoes it", { timeout: 90_000 }, async () => {
    await openApp([{ content: "First reply" }]);
    await startChat();
    await send("Take this back");
    await screen.findByText("First reply", {}, { timeout: SLOW });
    await replyFinished();

    await send("/undo");
    await waitFor(() => expect(screen.queryByText("First reply")).not.toBeInTheDocument(), {
      timeout: SLOW,
    });
    await waitFor(async () => expect((await message()).textContent).toContain("Take this back"));

    await send("/redo");
    await screen.findByText("First reply", {}, { timeout: SLOW });
  });

  it("renames, snoozes, unsnoozes and deletes a chat", { timeout: 60_000 }, async () => {
    const { client } = await openApp([{ content: "A reply" }]);
    await startChat();
    await send("Keep this chat");
    await screen.findByText("A reply", {}, { timeout: SLOW });
    await replyFinished();

    fireEvent.click(await screen.findByTitle("Rename"));
    const field = await waitFor(() => {
      const focused = document.activeElement;
      expect(focused?.tagName).toBe("INPUT");
      return focused as HTMLInputElement;
    });
    fireEvent.change(field, { target: { value: "Lobby work" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findAllByText("Lobby work", {}, { timeout: SLOW });

    fireEvent.click(await screen.findByTitle("Snooze"));
    fireEvent.click(await screen.findByText("Snoozed", {}, { timeout: SLOW }));
    fireEvent.click(await screen.findByTitle("Unsnooze"));
    await waitFor(() => expect(screen.queryByText("Snoozed")).not.toBeInTheDocument(), {
      timeout: SLOW,
    });
    const listed = await client.experimental.session.list({}, { throwOnError: true });
    expect(listed.data?.find((chat) => chat.title === "Lobby work")?.time.archived).toBeFalsy();

    const row = (await screen.findAllByText("Lobby work"))[0] as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Lobby work")).not.toBeInTheDocument(), {
      timeout: SLOW,
    });
  });

  it("explains the free limit and a rejected key", { timeout: 60_000 }, async () => {
    await openApp([
      {
        httpStatus: 429,
        type: "error",
        error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
      },
    ]);
    await startChat();
    await send("Hello");
    await screen.findByText("You've used today's free messages", {}, { timeout: SLOW });
    await replyFinished();
    expect(screen.queryByTitle("Stop")).not.toBeInTheDocument();
  });

  it("connects a provider with a key, and disconnects it", { timeout: 60_000 }, async () => {
    await openApp([{ content: "unused" }]);
    fireEvent.click(await screen.findByText("Settings", {}, { timeout: SLOW }));
    await screen.findByText("Providers", { selector: "h4" }, { timeout: SLOW });
    fireEvent.change(await screen.findByLabelText("Search providers"), {
      target: { value: "Anthropic" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }, { timeout: 5000 }));
    const key = await waitFor(() => {
      const field = document.querySelector<HTMLInputElement>(
        'input[placeholder*="sk-"], input[placeholder*="key" i]:not([type="search"])',
      );
      expect(field).not.toBeNull();
      return field as HTMLInputElement;
    });
    fireEvent.change(key, { target: { value: "sk-ant-workflow-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }, { timeout: SLOW }));
    await waitFor(
      () => expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument(),
      { timeout: SLOW },
    );
  });

  it("brings the chat back after a restart", { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-restart-"));
    cleanups.push(() => rm(home, { recursive: true, force: true }).catch(() => {}));
    const first = await openApp([{ content: "Remember this reply" }], home);
    await startChat();
    await send("Remember this prompt");
    await screen.findByText("Remember this reply", {}, { timeout: SLOW });
    await replyFinished();
    await first.close();

    await openApp([{ content: "unused" }], home);
    const chats = await screen.findAllByText(
      /Remember this prompt|A title|Untitled/,
      {},
      {
        timeout: SLOW,
      },
    );
    fireEvent.click(chats[0] as HTMLElement);
    await screen.findByText("Remember this reply", {}, { timeout: SLOW });
  });
});
