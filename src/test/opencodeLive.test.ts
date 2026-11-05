/**
 * Drives a real OpenCode server through BloxBot's client, the way the app does. It talks to a live
 * model, so it only runs when pointed at a binary:
 *
 *   OPENCODE_LIVE_BIN=/path/to/opencode pnpm vitest run src/test/opencodeLive.test.ts
 */
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { QueryClient } from "@tanstack/react-query";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isStudioTool } from "@/lib/aiTracing";
import { aiTracer } from "@/lib/analytics";
import { isFreeUsageLimit } from "@/lib/modelError";
import { createOpencodeClient, type OpencodeClient } from "@/lib/opencode/client";
import type { Event, ToolPart } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import { type MessagesCache, sseDispatch } from "@/lib/sseDispatch";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { PASSWORD, shellCall, startScriptedProvider, startServer } from "@/test/support/liveServer";
import { saveInstructions } from "../../electron/instructionFiles";
import { createOpenCodeConfig, withSystemPrompt } from "../../electron/opencodeConfig";

const BIN = process.env.OPENCODE_LIVE_BIN;
// Points the real-model suite at another provider, so it doesn't spend the free tier.
const LIVE_PROVIDERS = process.env.OPENCODE_LIVE_PROVIDERS;
const MODEL = {
  providerID: process.env.OPENCODE_LIVE_PROVIDER ?? "opencode",
  modelID: process.env.OPENCODE_LIVE_MODEL ?? "deepseek-v4.1-flash-free",
};
const TURN_MS = 120_000;

describe.skipIf(!BIN)("OpenCode server, through BloxBot's client", () => {
  let home: string;
  let server: ChildProcess;
  let mcp: Server;
  let client: OpencodeClient;
  let baseUrl: string;
  let queryClient: QueryClient;
  const active = { current: null as string | null };
  const events: Event[] = [];
  const pingCalls: unknown[] = [];
  const abort = new AbortController();

  async function waitFor<T>(what: string, check: () => T | undefined | false, ms = TURN_MS) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) {
        const seen = [...new Set(events.map((event) => event.type))].join(", ");
        throw new Error(`Timed out waiting for ${what}. Saw: ${seen}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const idleAfter = (sessionID: string, from: number) =>
    waitFor("the turn to end", () =>
      events
        .slice(from)
        .some((event) => event.type === "session.idle" && event.properties.sessionID === sessionID),
    );

  async function newChat(
    permission?: Parameters<OpencodeClient["session"]["create"]>[0]["permission"],
  ) {
    const created = await client.session.create({ permission }, { throwOnError: true });
    active.current = created.data.id;
    return created.data.id;
  }

  const send = (sessionID: string, text: string, system?: string) =>
    client.session.promptAsync(
      { sessionID, model: MODEL, system, parts: [{ type: "text", text }] },
      { throwOnError: true },
    );

  const cached = (sessionID: string) =>
    queryClient.getQueryData<MessagesCache>(qk.messages(sessionID));

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "bloxbot-live-"));
    const workspace = join(home, "workspace");
    const config = join(home, "config", "opencode");
    await mkdir(workspace, { recursive: true });
    await mkdir(config, { recursive: true });

    const makeMcp = () => {
      const instance = new McpServer(
        { name: "studio", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      instance.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "ping_studio",
            description: "Checks that Roblox Studio responds.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      instance.setRequestHandler(CallToolRequestSchema, async (request) => {
        pingCalls.push(request.params.name);
        return { content: [{ type: "text", text: "studio-pong" }] };
      });
      return instance;
    };
    mcp = createServer(async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await makeMcp().connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    await writeFile(
      join(config, "opencode.json"),
      JSON.stringify({
        ...createOpenCodeConfig({ url }),
        ...(LIVE_PROVIDERS
          ? { providers: JSON.parse(await readFile(LIVE_PROVIDERS, "utf8")) }
          : {}),
      }),
    );

    server = spawn(BIN as string, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
        OPENCODE_LOG_LEVEL: "info",
        OPENCODE_PASSWORD: PASSWORD,
      },
    });
    baseUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const read = (chunk: Buffer) => {
        output += chunk;
        const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match?.[1]) resolve(match[1]);
      };
      server.stdout?.on("data", read);
      server.stderr?.on("data", read);
      server.once("exit", () => reject(new Error(`OpenCode exited: ${output}`)));
    });

    client = createOpencodeClient({
      baseUrl,
      directory: workspace,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` },
    });
    queryClient = new QueryClient();
    const { stream } = await client.event.subscribe({}, { signal: abort.signal });
    void (async () => {
      for await (const event of stream) {
        events.push(event);
        sseDispatch(queryClient, event, active);
        // The app hands the tracer the same event objects, so it runs here too.
        aiTracer.handleEvent(event);
      }
    })().catch(() => undefined);
  }, 60_000);

  afterAll(async () => {
    abort.abort();
    server?.kill();
    mcp?.close();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it("runs a real goal, and pauses and clears it", async () => {
    const sessionID = await newChat();
    const run = (text: string) =>
      client.session.command(
        { sessionID, name: "goal", model: MODEL, parts: [{ type: "text", text }] },
        { throwOnError: true },
      );
    const from = events.length;
    await run("Reply with the single word done, then stop.");
    await waitFor("the model to reply", () =>
      events
        .slice(from)
        .some(
          (event) => event.type === "message.updated" && event.properties.info.role === "assistant",
        ),
    );
    await waitFor("the goal to settle", () =>
      events
        .slice(from)
        .some((event) => event.type === "session.idle" && event.properties.sessionID === sessionID),
    );
    // Whether the reviewer calls it met, a bare /goal always reports the state.
    await expect(run("")).rejects.toMatchObject({ name: "CommandExecutionError" });
    await run("clear").catch(() => undefined);
  }, 180_000);

  it.skipIf(LIVE_PROVIDERS)("lists the free provider, its models and ways to connect", async () => {
    const { data } = await client.provider.list({}, { throwOnError: true });
    expect(data.connected).toContain("opencode");
    const zen = data.all.find((provider) => provider.id === "opencode");
    expect(zen?.source).toBe("custom");
    expect(zen?.models[MODEL.modelID]?.capabilities.toolcall).toBe(true);
    expect(zen?.models[MODEL.modelID]?.capabilities.input.text).toBe(true);

    const auth = await client.provider.auth({}, { throwOnError: true });
    expect(auth.data.anthropic?.map((method) => method.type)).toContain("api");
    expect(auth.data["github-copilot"]?.[0]?.type).toBe("oauth");
  });

  it("connects the Studio MCP server", async () => {
    const status = await waitFor("MCP status", () => true);
    expect(status).toBe(true);
    const deadline = Date.now() + 20_000;
    let servers: Record<string, { status: string }> = {};
    while (Date.now() < deadline) {
      servers = (await client.mcp.status({}, { throwOnError: true })).data;
      if (Object.values(servers).some((server) => server.status === "connected")) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(Object.values(servers).map((server) => server.status)).toContain("connected");
  }, 30_000);

  it("keeps the ask-first rules for Studio's upload tools", async () => {
    // The engine's own reading of the config file: a key it doesn't know isn't kept.
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}` },
    });
    const documents = (await response.json()) as { info?: { permissions?: unknown[] } }[];
    const rules = documents.flatMap((document) => document.info?.permissions ?? []);
    for (const tool of ["upload_image", "open_cloud_invoke"]) {
      expect(rules).toContainEqual({
        action: `roblox-studio_${tool}`,
        resource: "*",
        effect: "ask",
      });
    }
  });

  it("manages chats: hidden metadata, rename, archive, delete", async () => {
    const hidden = await client.session.create(
      { title: "helper", metadata: { bloxbotHidden: true } },
      { throwOnError: true },
    );
    expect(hidden.data.metadata?.bloxbotHidden).toBe(true);

    await client.session.update(
      { sessionID: hidden.data.id, title: "renamed" },
      { throwOnError: true },
    );
    await client.session.update(
      { sessionID: hidden.data.id, time: { archived: Date.now() } },
      { throwOnError: true },
    );
    const listed = await client.experimental.session.list(
      { archived: true },
      { throwOnError: true },
    );
    const found = listed.data.find((session) => session.id === hidden.data.id);
    expect(found?.title).toBe("renamed");
    expect(found?.time.archived).toBeTypeOf("number");

    await client.session.delete({ sessionID: hidden.data.id }, { throwOnError: true });
    const after = await client.experimental.session.list(
      { archived: true },
      { throwOnError: true },
    );
    expect(after.data.some((session) => session.id === hidden.data.id)).toBe(false);
  });

  it(
    "streams a reply the same way history reports it, and applies instructions",
    async () => {
      const sessionID = await newChat();
      const from = events.length;
      await send(
        sessionID,
        "What is the codeword? Reply with only the codeword.",
        "The codeword is PERIWINKLE.",
      );
      await idleAfter(sessionID, from);

      const streamed = cached(sessionID);
      const history = await client.session.messages({ sessionID }, { throwOnError: true });
      expect(streamed?.messageIds).toEqual(history.data.map((message) => message.info.id));

      const summary = (parts: ReadonlyArray<{ type: string; text?: string }>) =>
        parts.filter((part) => part.type === "text").map((part) => part.text);
      for (const message of history.data) {
        const live = streamed?.messagesById[message.info.id];
        expect(live?.info.role).toBe(message.info.role);
        expect(summary(live?.parts ?? [])).toEqual(summary(message.parts));
      }
      const reply = history.data.at(-1);
      expect(reply?.info.role).toBe("assistant");
      expect(summary(reply?.parts ?? []).join("")).toContain("PERIWINKLE");

      const statuses = queryClient.getQueryData<Record<string, { type: string }>>(qk.statuses);
      expect(statuses?.[sessionID]?.type).toBe("idle");
      expect(events.slice(from).map((event) => event.type)).toContain("message.part.delta");
    },
    TURN_MS + 10_000,
  );

  it(
    "runs tools under the names the UI expects, including Studio's",
    async () => {
      const sessionID = await newChat();
      const from = events.length;
      await send(
        sessionID,
        "Use your tools, one at a time: 1) todowrite with one pending todo 'check', 2) the shell tool to run `echo live-probe`, 3) create the file note.txt containing hi, 4) call the Studio ping tool. Then reply DONE.",
      );
      await idleAfter(sessionID, from);

      const parts = (cached(sessionID)?.messageIds ?? []).flatMap(
        (id) => cached(sessionID)?.messagesById[id]?.parts ?? [],
      );
      const tools = parts.filter((part): part is ToolPart => part.type === "tool");
      const names = tools.map((tool) => tool.tool);
      expect(names).toContain("bash");
      expect(names).toContain("todowrite");

      const shell = tools.find((tool) => tool.tool === "bash");
      expect(shell?.state.status).toBe("completed");
      expect(shell?.state.status === "completed" && shell.state.output).toContain("live-probe");
      // GPT models edit through OpenCode's patch tool instead of write.
      const write = tools.find((tool) => tool.tool === "write" || tool.tool === "patch");
      expect(JSON.stringify(write?.state.input)).toContain("note.txt");

      const todos = await client.session.todo({ sessionID }, { throwOnError: true });
      expect(todos.data.length).toBeGreaterThan(0);
      expect(queryClient.getQueryData(qk.todos(sessionID))).toEqual(todos.data);

      expect(pingCalls).toContain("ping_studio");
      expect(names).toContain("execute");
      console.info("[live] tool names:", names.join(", "));
    },
    TURN_MS + 10_000,
  );

  it(
    "asks for approval and carries on after the reply",
    async () => {
      const sessionID = await newChat([{ permission: "bash", pattern: "*", action: "ask" }]);
      const from = events.length;
      await send(sessionID, "Run the shell command `echo approved-probe`, then reply DONE.");

      const asked = await waitFor("an approval request", () =>
        queryClient.getQueryData<{ id: string; permission: string }>(qk.permissions(sessionID)),
      );
      expect(asked.permission).toBe("bash");
      const open = await client.permission.list({}, { throwOnError: true });
      expect(open.data.map((request) => request.id)).toContain(asked.id);

      await client.permission.reply({ requestID: asked.id, reply: "once" }, { throwOnError: true });
      await idleAfter(sessionID, from);
      expect(queryClient.getQueryData(qk.permissions(sessionID))).toBeNull();
    },
    TURN_MS + 10_000,
  );

  it(
    "asks questions and answers them with the chosen option",
    async () => {
      const sessionID = await newChat();
      const from = events.length;
      await send(
        sessionID,
        "Use the question tool to ask my favourite colour, with the options Red and Blue. After I answer, reply with only the colour.",
      );
      const question = await waitFor("a question", () =>
        queryClient.getQueryData<{
          id: string;
          questions: Array<{ options: Array<{ label: string }> }>;
        }>(qk.questions(sessionID)),
      );
      expect(question.questions[0]?.options.map((option) => option.label)).toContain("Blue");

      await client.question.reply(
        { requestID: question.id, answers: [["Blue"]] },
        { throwOnError: true },
      );
      await idleAfter(sessionID, from);
      expect(queryClient.getQueryData(qk.questions(sessionID))).toBeNull();
      const history = await client.session.messages({ sessionID }, { throwOnError: true });
      const text = history.data
        .at(-1)
        ?.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      expect(text?.toLowerCase()).toContain("blue");
    },
    TURN_MS + 10_000,
  );

  it(
    "returns structured answers for hidden helper chats",
    async () => {
      const created = await client.session.create(
        { title: "helper", metadata: { bloxbotHidden: true } },
        { throwOnError: true },
      );
      const response = await client.session.prompt(
        {
          sessionID: created.data.id,
          model: MODEL,
          system: "You return small JSON answers.",
          format: {
            type: "json_schema",
            retryCount: 1,
            schema: {
              type: "object",
              properties: { answer: { type: "number" } },
              required: ["answer"],
            },
          },
          parts: [{ type: "text", text: "What is 2 + 2?" }],
        },
        { throwOnError: true },
      );
      expect(response.data.info.error).toBeUndefined();
      expect(response.data.info.structured).toEqual({ answer: 4 });
      await client.session.delete({ sessionID: created.data.id }, { throwOnError: true });
    },
    TURN_MS + 10_000,
  );

  it(
    "sends image attachments and reads them back",
    async () => {
      const sessionID = await newChat();
      const from = events.length;
      // A 1x1 red PNG.
      const url =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      await client.session.promptAsync(
        {
          sessionID,
          model: MODEL,
          parts: [
            { type: "text", text: "Reply with OK." },
            { type: "file", mime: "image/png", url, filename: "red.png" },
          ],
        },
        { throwOnError: true },
      );
      await idleAfter(sessionID, from);
      const history = await client.session.messages({ sessionID }, { throwOnError: true });
      const files = history.data[0]?.parts.filter((part) => part.type === "file");
      expect(files).toHaveLength(1);
      expect(files?.[0]?.type === "file" && files[0].url).toMatch(/^data:image\/png;base64,/);
      const live = cached(sessionID)?.messagesById[history.data[0]?.info.id as string]?.parts;
      expect(live?.some((part) => part.type === "file")).toBe(true);
    },
    TURN_MS + 10_000,
  );

  it("connects a provider with an API key and disconnects it", async () => {
    await client.auth.set(
      { providerID: "anthropic", auth: { type: "api", key: "sk-ant-not-a-real-key" } },
      { throwOnError: true },
    );
    await client.instance.dispose({}, { throwOnError: true });
    const connected = await client.provider.list({}, { throwOnError: true });
    expect(connected.data.all.find((provider) => provider.id === "anthropic")?.source).toBe("api");
    expect(connected.data.connected).toContain("anthropic");

    await client.auth.remove({ providerID: "anthropic" }, { throwOnError: true });
    await client.instance.dispose({}, { throwOnError: true });
    const removed = await client.provider.list({}, { throwOnError: true });
    expect(removed.data.connected).not.toContain("anthropic");
    expect(removed.data.connected).toContain("opencode");
  }, 30_000);

  it("starts an OAuth sign-in with the method the UI picked", async () => {
    const methods = await client.provider.auth({}, { throwOnError: true });
    const copilot = methods.data["github-copilot"] ?? [];
    const index = copilot.findIndex((method) => method.type === "oauth");
    expect(copilot[index]?.prompts?.map((prompt) => prompt.key)).toContain("deploymentType");
    const started = await client.provider.oauth.authorize(
      { providerID: "github-copilot", method: index, inputs: { deploymentType: "github.com" } },
      { throwOnError: true },
    );
    expect(started.data.url).toMatch(/^https:\/\/github\.com\//);
    expect(started.data.method).toMatch(/auto|code/);
  }, 30_000);

  it(
    "stops a running turn without calling it a failure",
    async () => {
      const sessionID = await newChat();
      const from = events.length;
      await send(sessionID, "Run the shell command `sleep 20`, then reply DONE.");
      await waitFor("the turn to start", () =>
        events.slice(from).some((event) => event.type === "session.status"),
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await client.session.abort({ sessionID }, { throwOnError: true });
      await idleAfter(sessionID, from);
      const errors = events
        .slice(from)
        .flatMap((event) => (event.type === "session.error" ? [event.properties.error?.name] : []));
      expect(errors.every((name) => name === "MessageAbortedError")).toBe(true);
    },
    TURN_MS + 10_000,
  );
});

/** Serves one OpenAI-style error for every request, as a provider rejecting the prompt would. */
async function startFailingProvider(status: number, body: object) {
  const requests: string[] = [];
  const provider = createServer((req, res) => {
    let received = "";
    req.on("data", (chunk) => {
      received += chunk;
    });
    req.on("end", () => {
      // OpenCode's title request has no tools, and isn't the reply being retried.
      if (received.includes('"tools"')) requests.push(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json", "retry-after": "3600" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  return {
    provider,
    requests,
    url: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
  };
}

describe.skipIf(!BIN)("[no model] OpenCode 2 failures", () => {
  it("ends the turn with the reason when the free limit is hit, and doesn't keep retrying", async () => {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-limit-"));
    const message = "Free usage limit reached. Subscribe to OpenCode Go to keep going.";
    const { provider, requests, url } = await startFailingProvider(429, {
      type: "error",
      error: { type: "FreeUsageLimitError", message },
    });
    await mkdir(join(home, "config", "opencode"), { recursive: true });
    await writeFile(
      join(home, "config", "opencode", "opencode.json"),
      JSON.stringify({ providers: { opencode: { settings: { baseURL: url } } } }),
    );
    const { child, baseUrl, workspace } = await startServer(BIN as string, home);
    const abort = new AbortController();
    try {
      const client = createOpencodeClient({
        baseUrl,
        directory: workspace,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
        },
      });
      const events: Event[] = [];
      const { stream } = await client.event.subscribe({}, { signal: abort.signal });
      void (async () => {
        for await (const event of stream) events.push(event);
      })().catch(() => undefined);

      const created = await client.session.create({}, { throwOnError: true });
      const sessionID = created.data.id;
      await client.session.promptAsync(
        { sessionID, model: MODEL, parts: [{ type: "text", text: "Hello" }] },
        { throwOnError: true },
      );
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !events.some((event) => event.type === "session.idle")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const summary = events.map((event) =>
        event.type === "session.status"
          ? `status:${event.properties.status.type}`
          : event.type === "session.error"
            ? `error:${JSON.stringify(event.properties.error)}`
            : event.type,
      );
      console.info("[live] free limit:", requests.length, "requests", JSON.stringify(summary));
      expect(requests).toHaveLength(1);
      const failure = events.find((event) => event.type === "session.error");
      expect(failure?.type === "session.error" && failure.properties.error?.data).toMatchObject({
        message: expect.stringContaining("Free usage limit"),
      });
      expect(events.some((event) => event.type === "session.idle")).toBe(true);
    } finally {
      abort.abort();
      child.kill();
      provider.close();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);
});

const V1_BIN = process.env.OPENCODE_LIVE_V1_BIN;

describe.skipIf(!BIN || !V1_BIN)("Upgrading from OpenCode 1", () => {
  it(
    "keeps a chat made on OpenCode 1 in a folder that isn't a git repository",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "bloxbot-upgrade-"));
      const auth = {
        Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
      };
      // Scripted, so this can't hang on the free tier's quota.
      const { provider, url } = await startScriptedProvider([{ content: "OK" }]);
      const configFile = join(home, "config", "opencode", "opencode.json");
      await mkdir(join(home, "config", "opencode"), { recursive: true });
      await writeFile(
        configFile,
        JSON.stringify({ provider: { opencode: { options: { baseURL: url } } } }),
      );
      try {
        const v1 = await startServer(V1_BIN as string, home);
        const created = await fetch(`${v1.baseUrl}/session`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ title: "Made on v1" }),
        }).then((response) => response.json() as Promise<{ id: string }>);
        // OpenCode's free models change, so use one this release actually lists.
        const catalog = await fetch(`${v1.baseUrl}/config/providers`, { headers: auth }).then(
          (response) =>
            response.json() as Promise<{
              providers: Array<{ id: string; models: Record<string, unknown> }>;
            }>,
        );
        const freeModels = Object.keys(
          catalog.providers.find((candidate) => candidate.id === "opencode")?.models ?? {},
        ).filter((id) => id.endsWith("-free"));
        await fetch(`${v1.baseUrl}/session/${created.id}/message`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            model: { providerID: "opencode", modelID: freeModels[0] },
            parts: [{ type: "text", text: "Reply with OK" }],
          }),
        });
        const messages = await fetch(`${v1.baseUrl}/session/${created.id}/message`, {
          headers: auth,
        }).then((response) => response.json() as Promise<Array<{ info: { role: string } }>>);
        const v1Roles = messages.map((message) => message.info.role);
        v1.child.kill();
        expect(v1Roles).toContain("assistant");
        await new Promise((resolve) => setTimeout(resolve, 1500));

        await writeFile(
          configFile,
          JSON.stringify({ providers: { opencode: { settings: { baseURL: url } } } }),
        );
        const v2 = await startServer(BIN as string, home);
        try {
          const client = createOpencodeClient({
            baseUrl: v2.baseUrl,
            directory: v2.workspace,
            headers: auth,
          });
          const deadline = Date.now() + 60_000;
          let titles: string[] = [];
          while (Date.now() < deadline) {
            const { data } = await client.experimental.session.list(
              { archived: true },
              { throwOnError: true },
            );
            titles = data.map((session) => session.title);
            if (titles.includes("Made on v1")) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          expect(titles).toContain("Made on v1");
          const { data } = await client.experimental.session.list(
            { archived: true },
            { throwOnError: true },
          );
          const session = data.find((candidate) => candidate.title === "Made on v1");
          const history = await client.session.messages(
            { sessionID: session?.id as string },
            { throwOnError: true },
          );
          console.info(
            "[live] upgraded history:",
            JSON.stringify(
              history.data.map((message) => [
                message.info.role,
                message.parts.map((part) => part.type),
              ]),
            ),
          );
          expect(history.data.map((message) => message.info.role)).toEqual(v1Roles);
        } finally {
          v2.child.kill();
        }
      } finally {
        provider.close();
        await rm(home, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    TURN_MS,
  );
});

describe.skipIf(!BIN)("[no model] Running a chat", () => {
  async function withServer(
    replies: ReadonlyArray<object>,
    run: (context: {
      client: OpencodeClient;
      configFile: string;
      bodies: string[];
      events: Event[];
    }) => Promise<void>,
    mcpUrl = "http://127.0.0.1:9/mcp",
    prepare?: (home: string) => Promise<void>,
  ) {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-chat-"));
    await prepare?.(home);
    const { provider, url, bodies } = await startScriptedProvider(replies);
    const configFile = join(home, "config", "opencode", "opencode.json");
    await mkdir(join(home, "config", "opencode"), { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        ...createOpenCodeConfig({ url: mcpUrl }),
        providers: { opencode: { settings: { baseURL: url } } },
      }),
    );
    const { child, baseUrl, workspace } = await startServer(BIN as string, home);
    const abort = new AbortController();
    try {
      const client = createOpencodeClient({
        baseUrl,
        directory: workspace,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
        },
      });
      const events: Event[] = [];
      const { stream } = await client.event.subscribe({}, { signal: abort.signal });
      void (async () => {
        for await (const event of stream) events.push(event);
      })().catch(() => undefined);
      await run({ client, configFile, bodies, events });
    } finally {
      abort.abort();
      child.kill();
      provider.close();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  it("follows the instructions saved in Settings, and adding them keeps the conversation's start", async () => {
    await withServer(
      [{ content: "OK" }, { content: "OK" }, { content: "OK" }],
      async ({ client, configFile, bodies, events }) => {
        const created = await client.session.create({}, { throwOnError: true });
        const folder = dirname(configFile);
        await turn(client, events, created.data.id, "FIRST_MESSAGE");
        const before = bodies.at(-1) as string;

        await saveInstructions(folder, "FIRST_RULE");
        await client.instance.dispose({}, { throwOnError: true });
        await turn(client, events, created.data.id, "Again");
        const after = bodies.at(-1) as string;
        expect(after).toContain("FIRST_RULE");
        // BloxBot's own prompt stays, and the rule comes after what the model has already cached.
        expect(after).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));
        expect(after.indexOf("FIRST_RULE")).toBeGreaterThan(after.indexOf("FIRST_MESSAGE"));
        const start = before.slice(0, before.indexOf("FIRST_MESSAGE"));
        expect(after.startsWith(start)).toBe(true);

        await saveInstructions(folder, "");
        await client.instance.dispose({}, { throwOnError: true });
        // It stays in a chat that already has it, as part of that conversation, but new ones don't.
        const next = await client.session.create({}, { throwOnError: true });
        await turn(client, events, next.data.id, "Once more");
        expect(bodies.at(-1)).not.toContain("FIRST_RULE");
      },
    );
  }, 30_000);

  it("keeps the user's other setups out of the chat", async () => {
    const skill = async (root: string, marker: string) => {
      await mkdir(join(root, "skills", marker), { recursive: true });
      await writeFile(
        join(root, "skills", marker, "SKILL.md"),
        `---\nname: ${marker}\ndescription: ${marker}\n---\nBody\n`,
      );
    };
    const fakeHome = await mkdtemp(join(tmpdir(), "bloxbot-home-"));
    await skill(join(fakeHome, ".claude"), "FROM_CLAUDE_FOLDER");
    await skill(join(fakeHome, ".agents"), "FROM_AGENTS_FOLDER");
    const realHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      await withServer(
        [{ content: "OK" }],
        async ({ client, bodies, events }) => {
          const created = await client.session.create({}, { throwOnError: true });
          await turn(client, events, created.data.id, "Hello");
          const body = bodies.at(-1);
          expect(body).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));
          expect(body).not.toContain("FROM_");
        },
        undefined,
        async (home) => {
          // The folder above the workspace, as the home folder is above ~/BloxBot.
          await skill(join(home, ".opencode"), "FROM_PARENT_OPENCODE");
          await writeFile(join(home, "AGENTS.md"), "FROM_PARENT_AGENTS_MD");
          await writeFile(join(home, "instruction.md"), "FROM_PARENT_CONFIG");
          await writeFile(
            join(home, "opencode.json"),
            JSON.stringify({ instructions: [join(home, "instruction.md")] }),
          );
        },
      );
    } finally {
      process.env.HOME = realHome;
      await rm(fakeHome, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  async function turn(client: OpencodeClient, events: Event[], sessionID: string, text: string) {
    const from = events.length;
    await client.session.promptAsync(
      { sessionID, model: MODEL, parts: [{ type: "text", text }] },
      { throwOnError: true },
    );
    const deadline = Date.now() + 30_000;
    while (!events.slice(from).some((event) => event.type === "session.idle")) {
      if (Date.now() > deadline) throw new Error("The turn didn't end.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("runs /goal and undoes a message through OpenCode's own commands", async () => {
    await withServer(
      [{ content: "On it." }, { content: "Again." }, { content: "Once more." }],
      async ({ client, events }) => {
        const created = await client.session.create({}, { throwOnError: true });
        const sessionID = created.data.id;
        const run = (name: string, text: string) =>
          client.session.command(
            { sessionID, name, model: MODEL, parts: [{ type: "text", text }] },
            { throwOnError: true },
          );

        // A bare /goal reports through a rejection, which the composer shows as a message.
        await expect(run("goal", "")).rejects.toMatchObject({ name: "CommandExecutionError" });
        await expect(run("nosuch", "")).rejects.toThrow(/not found/i);

        const from = events.length;
        await run("goal", "Make it work");
        const deadline = Date.now() + 30_000;
        while (!events.slice(from).some((event) => event.type === "session.idle")) {
          if (Date.now() > deadline) throw new Error("The goal's turn didn't end.");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await run("goal", "clear");

        await turn(client, events, sessionID, "Second prompt");
        const before = await client.session.messages({ sessionID }, { throwOnError: true });
        const prompt = before.data?.findLast((message) => message.info.role === "user");
        expect(prompt).toBeDefined();
        await client.session.undo(
          { sessionID, messageID: prompt?.info.id as string },
          { throwOnError: true },
        );
        const revertOf = async () => {
          const sessions = await client.experimental.session.list({}, { throwOnError: true });
          return sessions.data?.find((session) => session.id === sessionID)?.revert;
        };
        expect((await revertOf())?.messageID).toBe(prompt?.info.id);
        await client.session.redo({ sessionID }, { throwOnError: true });
        expect(await revertOf()).toBeUndefined();

        // Sending after an undo makes it final, and clears the mark that hides those messages.
        await client.session.undo(
          { sessionID, messageID: prompt?.info.id as string },
          { throwOnError: true },
        );
        await turn(client, events, sessionID, "Instead do this");
        expect(await revertOf()).toBeUndefined();
        const after = await client.session.messages({ sessionID }, { throwOnError: true });
        expect(after.data?.some((message) => message.info.id === prompt?.info.id)).toBe(false);

        const forked = await client.session.fork({ sessionID }, { throwOnError: true });
        expect(forked.data?.id).not.toBe(sessionID);
        await client.session.compact({ sessionID }, { throwOnError: true });
      },
    );
  }, 90_000);

  it("moves a chat to the default model when no model is selected", async () => {
    await withServer(
      [{ content: "One" }, { content: "Two" }],
      async ({ client, bodies, events }) => {
        const providers = await client.provider.list({}, { throwOnError: true });
        const defaultID = providers.data?.default.opencode as string;
        const other = Object.keys(
          providers.data?.all.find((provider) => provider.id === "opencode")?.models ?? {},
        ).find((id) => id !== defaultID) as string;
        expect(defaultID).toBeTruthy();
        expect(other).toBeTruthy();

        const created = await client.session.create({}, { throwOnError: true });
        const sessionID = created.data.id;
        const send = async (model?: { providerID: string; modelID: string }) => {
          const from = events.length;
          await client.session.promptAsync(
            { sessionID, model, parts: [{ type: "text", text: "Hello" }] },
            { throwOnError: true },
          );
          const deadline = Date.now() + 30_000;
          while (!events.slice(from).some((event) => event.type === "session.idle")) {
            if (Date.now() > deadline) throw new Error("The turn didn't end.");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return JSON.parse(bodies.at(-1) ?? "{}").model;
        };

        expect(await send({ providerID: "opencode", modelID: other })).toBe(other);
        expect(await send()).toBe(defaultID);
      },
    );
  }, 60_000);

  it("streams a reply and runs a shell tool on this platform", async () => {
    await withServer(
      [shellCall("echo ci-probe"), { content: "All done" }],
      async ({ client, events }) => {
        const created = await client.session.create({}, { throwOnError: true });
        const sessionID = created.data.id;
        await turn(client, events, sessionID, "Run it.");

        const history = await client.session.messages({ sessionID }, { throwOnError: true });
        const parts = history.data.flatMap((message) => message.parts);
        const shell = parts.find((part): part is ToolPart => part.type === "tool");
        expect(shell?.tool).toBe("bash");
        expect(shell?.state.status === "completed" && shell.state.output).toContain("ci-probe");
        expect(parts.some((part) => part.type === "text" && part.text === "All done")).toBe(true);
        expect(events.some((event) => event.type === "message.part.delta")).toBe(true);
      },
    );
  }, 60_000);

  it("uses the default system prompt, then an edited one, then the default again", async () => {
    await withServer([{ content: "OK" }], async ({ client, configFile, bodies, events }) => {
      const created = await client.session.create({}, { throwOnError: true });
      const sessionID = created.data.id;
      const lastBody = () => bodies.at(-1) ?? "";
      const edit = async (prompt: string | null) => {
        await writeFile(configFile, withSystemPrompt(await readFile(configFile, "utf8"), prompt));
        await client.instance.dispose({}, { throwOnError: true });
      };

      await turn(client, events, sessionID, "One");
      expect(lastBody()).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));

      await edit("Always answer like a pirate.");
      await turn(client, events, sessionID, "Two");
      expect(lastBody()).toContain("Always answer like a pirate.");
      expect(lastBody()).not.toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));

      await edit(null);
      await turn(client, events, sessionID, "Three");
      expect(lastBody()).toContain(DEFAULT_SYSTEM_PROMPT.slice(0, 40));
    });
  }, 60_000);

  it("lets a running chat finish when a system prompt edit reloads OpenCode", async () => {
    await withServer(
      [
        shellCall(process.platform === "win32" ? "ping -n 6 127.0.0.1" : "sleep 5"),
        { content: "Finished" },
      ],
      async ({ client, events }) => {
        const created = await client.session.create({}, { throwOnError: true });
        const sessionID = created.data.id;
        const from = events.length;
        await client.session.promptAsync(
          { sessionID, model: MODEL, parts: [{ type: "text", text: "Run it." }] },
          { throwOnError: true },
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await client.instance.dispose({}, { throwOnError: true });
        const deadline = Date.now() + 30_000;
        while (!events.slice(from).some((event) => event.type === "session.idle")) {
          if (Date.now() > deadline) throw new Error("The turn didn't end.");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const errors = events
          .slice(from)
          .flatMap((event) =>
            event.type === "session.error" ? [event.properties.error?.name] : [],
          );
        expect(errors).toEqual([]);
        const history = await client.session.messages({ sessionID }, { throwOnError: true });
        const parts = history.data.flatMap((message) => message.parts);
        expect(
          parts.some((part) => part.type === "tool" && part.state.status === "completed"),
        ).toBe(true);
        expect(parts.some((part) => part.type === "text" && part.text === "Finished")).toBe(true);
      },
    );
  }, 60_000);

  const askForJson = (client: OpencodeClient, sessionID: string, retryCount = 1) =>
    client.session.prompt(
      {
        sessionID,
        model: MODEL,
        system: "Helper instructions.",
        format: { type: "json_schema", retryCount, schema: { type: "object" } },
        parts: [{ type: "text", text: "Answer the question." }],
      },
      { throwOnError: true },
    );

  it("answers helper prompts in JSON, adds nothing to the chat and sends tools for the free tier", async () => {
    await withServer([{ content: '```json\n{"answer":4}\n```' }], async ({ client, bodies }) => {
      const created = await client.session.create(
        { metadata: { bloxbotHidden: true } },
        { throwOnError: true },
      );
      const sessionID = created.data.id;
      const response = await askForJson(client, sessionID);
      expect(response.data.info.error).toBeUndefined();
      expect(response.data.info.structured).toEqual({ answer: 4 });

      const body = bodies.at(-1) ?? "";
      expect(body).toContain("Helper instructions.");
      expect(JSON.parse(body).tools.length).toBeGreaterThan(0);
      const history = await client.session.messages({ sessionID }, { throwOnError: true });
      expect(history.data).toEqual([]);
    });
  }, 60_000);

  it("never runs a tool from a helper prompt, and asks again with what came back", async () => {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-marker-"));
    const marker = join(home, "must-not-exist.txt");
    await withServer(
      [shellCall(`echo no > ${marker}`), { content: "No JSON here" }, { content: '{"answer":4}' }],
      async ({ client, bodies }) => {
        const created = await client.session.create(
          { metadata: { bloxbotHidden: true } },
          { throwOnError: true },
        );
        const response = await askForJson(client, created.data.id, 2);
        expect(response.data.info.structured).toEqual({ answer: 4 });
        await expect(access(marker)).rejects.toThrow();
        expect(bodies.at(-1)).toContain("You replied: No JSON here");
      },
    );
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it("reports the reason when a helper prompt fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "bloxbot-helper-limit-"));
    const { provider, url } = await startFailingProvider(429, {
      type: "error",
      error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
    });
    await mkdir(join(home, "config", "opencode"), { recursive: true });
    await writeFile(
      join(home, "config", "opencode", "opencode.json"),
      JSON.stringify({ providers: { opencode: { settings: { baseURL: url } } } }),
    );
    const { child, baseUrl, workspace } = await startServer(BIN as string, home);
    try {
      const client = createOpencodeClient({
        baseUrl,
        directory: workspace,
        headers: {
          Authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`,
        },
      });
      const created = await client.session.create({}, { throwOnError: true });
      const response = await askForJson(client, created.data.id);
      const error = response.data.info.error;
      expect(error && isFreeUsageLimit(error)).toBe(true);
    } finally {
      child.kill();
      provider.close();
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 60_000);

  it("runs Studio tools from Code Mode, and counts them as Studio use", async () => {
    const calls: string[] = [];
    const mcp = createServer(async (req, res) => {
      const server = new McpServer(
        { name: "studio", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: "ping_studio",
            description: "Checks that Roblox Studio responds.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push(request.params.name);
        return { content: [{ type: "text", text: "studio-pong" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
    const code = 'return await tools["roblox-studio"].ping_studio({});';
    try {
      await withServer(
        [
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
        ],
        async ({ client, events }) => {
          const deadline = Date.now() + 20_000;
          let connected = false;
          while (!connected && Date.now() < deadline) {
            const servers = (await client.mcp.status({}, { throwOnError: true })).data;
            connected = servers["roblox-studio"]?.status === "connected";
            if (!connected) await new Promise((resolve) => setTimeout(resolve, 200));
          }
          expect(connected).toBe(true);
          // A server reports connected a few seconds before its tools reach the Code Mode catalog.
          await new Promise((resolve) => setTimeout(resolve, 10_000));

          const created = await client.session.create({}, { throwOnError: true });
          const sessionID = created.data.id;
          await turn(client, events, sessionID, "Ping Studio.");

          const history = await client.session.messages({ sessionID }, { throwOnError: true });
          const tool = history.data
            .flatMap((message) => message.parts)
            .find((part): part is ToolPart => part.type === "tool");
          expect(tool?.tool).toBe("execute");
          expect(tool?.state.input.code).toBe(code);
          expect(calls).toEqual(["ping_studio"]);
          expect(tool?.state.status === "completed" && tool.state.output).toContain("studio-pong");
          expect(isStudioTool("execute", tool?.state.input)).toBe(true);
        },
        mcpUrl,
      );
    } finally {
      mcp.close();
    }
  }, 60_000);
});
