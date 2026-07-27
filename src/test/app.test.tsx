/**
 * End-to-end integration tests.
 *
 * These render the real component tree (Chat, ChatSidebar, ChatMessages, ChatInput)
 * inside the real provider hierarchy. Only the system boundary is mocked:
 * - SDK client (createOpencodeClient)
 *
 * Each test simulates a real user journey and asserts on what appears on screen.
 */

import type { Session } from "@opencode-ai/sdk/v2/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { type MessagesCache, sseDispatch } from "@/lib/sseDispatch";
import { ActiveSessionProvider } from "@/providers/ActiveSessionProvider";
import { ExplorerReferenceProvider } from "@/providers/ExplorerReferenceProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

// Mock react-virtual so all items render in jsdom (no viewport measurement)
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 80,
        size: 80,
        end: (i + 1) * 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeSession(id: string, title: string, createdAt = Date.now()): Session {
  return {
    id,
    title,
    time: { created: createdAt, updated: createdAt },
    version: 1,
    parentID: "",
  } as Session;
}

/**
 * Build a minimal but real provider tree for integration tests.
 * We skip OpenCodeClientProvider's lifecycle (desktop bridge, SSE, init)
 * and inject the client + ready state directly via the exported context.
 * Everything below that — ActiveSessionProvider, PreferencesProvider,
 * and all components — runs with real code.
 */
function TestApp({
  client,
  queryClient,
}: {
  client: ReturnType<typeof createClient>;
  queryClient: QueryClient;
}) {
  const activeSessionIdRef = useRef<string | null>(null);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <OpenCodeClientContext.Provider
          value={{
            client: client as never,
            status: "ready",
            port: 4096,
            ready: true,
            initError: null,
          }}
        >
          <ActiveSessionProvider activeSessionIdRef={activeSessionIdRef}>
            <PreferencesProvider>
              <ExplorerReferenceProvider>
                <ChatWithSonner />
              </ExplorerReferenceProvider>
            </PreferencesProvider>
          </ActiveSessionProvider>
        </OpenCodeClientContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/** Lazy-import Chat to avoid top-level desktop bridge calls in module scope */
import Chat from "@/components/Chat";
import { Toaster } from "@/components/ui/sonner";

function ChatWithSonner() {
  return (
    <>
      <Chat />
      <Toaster />
    </>
  );
}

function createClient(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn().mockResolvedValue({ data: null }),
      create: vi.fn().mockResolvedValue({ data: null }),
      delete: vi.fn().mockResolvedValue({ data: true }),
      update: vi.fn().mockResolvedValue({ data: null }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      todo: vi.fn().mockResolvedValue({ data: [] }),
      promptAsync: vi.fn().mockResolvedValue({}),
      ...overrides,
    },
    provider: {
      list: vi.fn().mockResolvedValue({
        data: {
          all: [
            {
              id: "anthropic",
              name: "Anthropic",
              env: [],
              models: {
                "claude-3.5-sonnet": {
                  id: "claude-3.5-sonnet",
                  name: "Claude 3.5 Sonnet",
                },
              },
            },
          ],
          connected: ["anthropic"],
          default: { anthropic: "claude-3.5-sonnet" },
        },
      }),
      oauth: { authorize: vi.fn(), callback: vi.fn() },
      auth: vi.fn().mockResolvedValue({ data: undefined }),
    },
    auth: { set: vi.fn(), remove: vi.fn() },
    question: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      reply: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    },
    permission: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      reply: vi.fn().mockResolvedValue({}),
    },
    event: { subscribe: vi.fn().mockResolvedValue({ stream: null }) },
    app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
    mcp: {
      status: vi.fn().mockResolvedValue({
        data: { "roblox-studio": { status: "connected" } },
      }),
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
    instance: { dispose: vi.fn() },
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: Number.POSITIVE_INFINITY,
        retry: false,
      },
    },
  });
}

/** Seed the query cache with the minimum state the app needs to be "ready" */
function seedReadyState(
  queryClient: QueryClient,
  opts: { sessions?: Session[]; detailedAnalytics?: "unset" | "enabled" | "disabled" } = {},
) {
  const sessions = opts.sessions ?? [];

  queryClient.setQueryData(qk.sessions, sessions);
  queryClient.setQueryData(qk.statuses, {});
  queryClient.setQueryData(qk.agents, []);
  queryClient.setQueryData(qk.providers, {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: {
          "claude-3.5-sonnet": { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
        },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "claude-3.5-sonnet" },
  });
  queryClient.setQueryData(qk.config, {
    lastModel: "anthropic/claude-3.5-sonnet",
    hiddenModels: [],
    theme: "system",
    detailedAnalytics: opts.detailedAnalytics ?? "disabled",
  });
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  toast.dismiss();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("User journeys", () => {
  it("prompts once for detailed analytics and keeps the choice toggleable", async () => {
    const client = createClient();
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { detailedAnalytics: "unset" });

    render(<TestApp client={client} queryClient={queryClient} />);

    const consentTitle = await screen.findByText("Help improve BloxBot");
    expect(consentTitle).toBeVisible();
    expect(consentTitle.closest("[data-sonner-toast]")).toHaveClass("analytics-consent-toast");
    fireEvent.click(screen.getByRole("button", { name: "Share usage" }));
    await expect(desktop.loadConfig()).resolves.toMatchObject({ detailedAnalytics: "enabled" });

    fireEvent.click(await screen.findByText("Settings"));
    fireEvent.click(await screen.findByRole("button", { name: "Privacy" }));
    const analyticsSwitch = screen.getByRole("switch", {
      name: "Share detailed usage analytics",
    });
    expect(analyticsSwitch).toHaveAttribute("aria-checked", "true");

    fireEvent.click(analyticsSwitch);

    expect(analyticsSwitch).toHaveAttribute("aria-checked", "false");
    await expect(desktop.loadConfig()).resolves.toMatchObject({ detailedAnalytics: "disabled" });
  });

  it("guides the user until Roblox Studio connects", async () => {
    const client = createClient();
    const studioStatus = vi
      .fn()
      .mockResolvedValue({ data: { "roblox-studio": { status: "failed" } } });
    client.mcp.status = studioStatus;
    client.mcp.connect = vi.fn().mockResolvedValue({});
    const queryClient = createQueryClient();
    seedReadyState(queryClient);

    render(<TestApp client={client} queryClient={queryClient} />);

    expect(await screen.findByRole("heading", { name: "Let's connect Studio" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    studioStatus.mockResolvedValue({
      data: { "roblox-studio": { status: "connected" } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("heading", { name: "Studio connected" })).toBeVisible();
  });

  it("creates a session and shows the chat interface", async () => {
    const newSession = makeSession("s1", "New Session");
    const client = createClient({
      create: vi.fn().mockResolvedValue({ data: newSession }),
      get: vi.fn().mockResolvedValue({ data: newSession }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient);

    render(<TestApp client={client} queryClient={queryClient} />);

    // We should see "What would you like to build?" and a "New Session" button
    const newSessionBtn = await screen.findByText("New Session");
    await act(async () => {
      fireEvent.click(newSessionBtn);
    });

    // After session creation, the SDK should have been called
    expect(client.session.create).toHaveBeenCalled();

    // The chat area for the session should now be visible (textarea)
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Describe what you want to build...")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Coordinate multiple Studio places" }),
    ).not.toBeInTheDocument();
  });

  it("switches to the latest session immediately without waiting for older requests", async () => {
    const first = makeSession("s1", "First Session");
    const second = makeSession("s2", "Second Session");
    const never = new Promise<never>(() => {});
    const client = createClient({
      get: vi.fn().mockReturnValue(never),
      messages: vi.fn().mockReturnValue(never),
      todo: vi.fn().mockReturnValue(never),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [first, second] });

    render(<TestApp client={client} queryClient={queryClient} />);

    const firstTitle = await screen.findByText("First Session");
    await act(async () => {
      fireEvent.click(firstTitle);
      fireEvent.click(screen.getByText("Second Session"));
    });

    expect(await screen.findByRole("heading", { name: "Second Session" })).toBeVisible();
    expect(client.session.get).not.toHaveBeenCalled();
  });

  it("sends a message and shows the assistant response via SSE", async () => {
    const session = makeSession("s1", "My Session");
    const client = createClient({
      create: vi.fn().mockResolvedValue({ data: session }),
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      promptAsync: vi.fn().mockResolvedValue({}),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    // Pre-populate the active session state
    queryClient.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: [],
      messagesById: {},
    });
    queryClient.setQueryData(qk.todos("s1"), []);
    queryClient.setQueryData(qk.questions("s1"), null);
    queryClient.setQueryData(qk.permissions("s1"), null);

    render(<TestApp client={client} queryClient={queryClient} />);

    // Click the session in the sidebar to select it
    const sessionTitle = await screen.findByText("My Session");
    await act(async () => {
      fireEvent.click(sessionTitle);
    });

    // Wait for the chat input to appear
    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    // Type and send a message
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Build me a Roblox game" } });
    });
    const sendBtn = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    expect(client.session.promptAsync).toHaveBeenCalled();
    const callArgs = client.session.promptAsync.mock.calls[0][0];
    expect(callArgs.parts[0].text).toBe("Build me a Roblox game");

    // Simulate SSE: assistant message comes in
    const activeRef = { current: "s1" };
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_1",
              sessionID: "s1",
              role: "assistant",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as never,
        activeRef,
      );
    });

    // Simulate SSE: text part streams in
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "part_1",
              messageID: "msg_1",
              sessionID: "s1",
              type: "text",
              text: "I'll create a Roblox obby for you!",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as never,
        activeRef,
      );
    });

    // The assistant's response should appear on screen
    await waitFor(() => {
      expect(screen.getByText(/I'll create a Roblox obby for you!/)).toBeInTheDocument();
    });
  });

  it("shows permission prompt and user can approve it", async () => {
    const session = makeSession("s1", "My Session");
    const permRequest = {
      id: "perm_1",
      sessionID: "s1",
      permission: "bash",
      patterns: ["rm -rf /tmp/test"],
    };
    const client = createClient({
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg_1",
              sessionID: "s1",
              role: "assistant",
              time: { created: Date.now(), updated: Date.now() },
            },
            parts: [],
          },
        ],
      }),
    });
    // Make permission.list return our permission so selectSession picks it up
    client.permission.list = vi.fn().mockResolvedValue({ data: [permRequest] });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    render(<TestApp client={client} queryClient={queryClient} />);

    // Select the session — this triggers selectSession which fetches permissions from SDK
    const sessionTitle = await screen.findByText("My Session");
    await act(async () => {
      fireEvent.click(sessionTitle);
    });

    // The permission prompt should appear (populated by selectSession from SDK response)
    await waitFor(() => {
      expect(screen.getByText("Permission Required")).toBeInTheDocument();
      expect(screen.getByText("bash")).toBeInTheDocument();
    });

    // Click "Allow Once"
    const allowBtn = screen.getByText("Allow Once");
    await act(async () => {
      fireEvent.click(allowBtn);
    });

    expect(client.permission.reply).toHaveBeenCalledWith(
      {
        requestID: "perm_1",
        reply: "once",
      },
      { throwOnError: true },
    );
  });

  it("snoozes a session and moves it out of the active list", async () => {
    const s1 = makeSession("s1", "Session One");
    const s2 = makeSession("s2", "Session Two");
    const snoozed = { ...s1, time: { ...s1.time, archived: Date.now() } };
    const client = createClient({
      update: vi.fn().mockResolvedValue({ data: snoozed }),
      get: vi.fn().mockResolvedValue({ data: s1 }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [s1, s2] });
    queryClient.setQueryData(qk.todos("s1"), []);
    queryClient.setQueryData(qk.questions("s1"), null);
    queryClient.setQueryData(qk.permissions("s1"), null);

    render(<TestApp client={client} queryClient={queryClient} />);

    // Both sessions should be visible in sidebar
    expect(await screen.findByText("Session One")).toBeInTheDocument();
    expect(screen.getByText("Session Two")).toBeInTheDocument();

    const snoozeButtons = screen.getAllByTitle("Snooze");
    await act(async () => {
      fireEvent.click(snoozeButtons[0]);
    });

    expect(client.session.update).toHaveBeenCalledWith(
      { sessionID: "s1", time: { archived: expect.any(Number) } },
      { throwOnError: true },
    );
    expect(client.session.delete).not.toHaveBeenCalled();

    // Session One leaves the active list and the folded snoozed section appears.
    await waitFor(() => {
      expect(screen.queryByText("Session One")).not.toBeInTheDocument();
      expect(screen.getByText("Snoozed")).toBeInTheDocument();
    });
    // Session Two should still be there
    expect(screen.getByText("Session Two")).toBeInTheDocument();
  });

  it("shows question prompt and user can answer it", async () => {
    const session = makeSession("s1", "My Session");
    const questionReq = {
      id: "q1",
      sessionID: "s1",
      questions: [
        {
          header: "File Conflict",
          question: "The file already exists. What should I do?",
          options: [
            { label: "Overwrite", description: "Replace the file" },
            { label: "Skip", description: "Leave it" },
          ],
          multiple: false,
          custom: true,
        },
      ],
    };
    const client = createClient({
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({
        data: [
          {
            info: {
              id: "msg_1",
              sessionID: "s1",
              role: "assistant",
              time: { created: Date.now(), updated: Date.now() },
            },
            parts: [],
          },
        ],
      }),
    });
    // Make question.list return our question so selectSession picks it up
    client.question.list = vi.fn().mockResolvedValue({ data: [questionReq] });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    render(<TestApp client={client} queryClient={queryClient} />);

    // Select session — selectSession fetches questions from SDK
    await act(async () => {
      fireEvent.click(await screen.findByText("My Session"));
    });

    // Question prompt should appear (populated by selectSession from SDK response)
    await waitFor(() => {
      expect(screen.getByText("File Conflict")).toBeInTheDocument();
      expect(screen.getByText("The file already exists. What should I do?")).toBeInTheDocument();
    });

    // Click "Overwrite" option
    await act(async () => {
      fireEvent.click(screen.getByText("Overwrite"));
    });

    // Submit the answer
    await act(async () => {
      fireEvent.click(screen.getByText("Submit"));
    });

    expect(client.question.reply).toHaveBeenCalledWith(
      {
        requestID: "q1",
        answers: [["Overwrite"]],
      },
      { throwOnError: true },
    );
  });

  it("streams tool use (bash command) and shows it in the UI", async () => {
    const session = makeSession("s1", "My Session");
    const client = createClient({
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    queryClient.setQueryData<MessagesCache>(qk.messages("s1"), {
      messageIds: [],
      messagesById: {},
    });
    queryClient.setQueryData(qk.todos("s1"), []);
    queryClient.setQueryData(qk.questions("s1"), null);
    queryClient.setQueryData(qk.permissions("s1"), null);

    render(<TestApp client={client} queryClient={queryClient} />);

    // Select session
    await act(async () => {
      fireEvent.click(await screen.findByText("My Session"));
    });
    await screen.findByPlaceholderText("Describe what you want to build...");

    const activeRef = { current: "s1" };

    // SSE: assistant message
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg_a",
              sessionID: "s1",
              role: "assistant",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as never,
        activeRef,
      );
    });

    // SSE: tool part — bash command running
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "tool_1",
              messageID: "msg_a",
              sessionID: "s1",
              type: "tool",
              tool: "bash",
              state: {
                status: "running",
                input: { command: "ls -la src/", description: "List source files" },
              },
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as never,
        activeRef,
      );
    });

    // The bash command should be visible
    await waitFor(() => {
      expect(screen.getByText("List source files")).toBeInTheDocument();
      expect(screen.getByText("ls -la src/")).toBeInTheDocument();
      expect(screen.getByText("Running...")).toBeInTheDocument();
    });

    // SSE: tool completes with output
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.part.updated",
          properties: {
            part: {
              id: "tool_1",
              messageID: "msg_a",
              sessionID: "s1",
              type: "tool",
              tool: "bash",
              state: {
                status: "completed",
                input: { command: "ls -la src/", description: "List source files" },
                output: "total 48\ndrwxr-xr-x  12 user  staff  384 Mar 21 10:00 .",
              },
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as never,
        activeRef,
      );
    });

    // Running indicator should be gone, output should be available
    await waitFor(() => {
      expect(screen.queryByText("Running...")).not.toBeInTheDocument();
    });
  });

  it("shows OpenCode's structured free-tier action while waiting to retry", async () => {
    const session = makeSession("s1", "Quota Session");
    const client = createClient({
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    render(<TestApp client={client} queryClient={queryClient} />);
    await act(async () => {
      fireEvent.click(await screen.findByText("Quota Session"));
    });
    await screen.findByPlaceholderText("Describe what you want to build...");

    const activeRef = { current: "s1" };
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "session.status",
          properties: { sessionID: "s1", status: { type: "busy" } },
        },
        activeRef,
      );
    });
    expect(await screen.findByText("Working")).toBeInTheDocument();

    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "session.status",
          properties: {
            sessionID: "s1",
            status: {
              type: "retry",
              attempt: 1,
              message: "Free usage exceeded, subscribe to Go",
              next: Date.now() + 60_000,
              action: {
                provider: "opencode",
                reason: "free_tier_limit",
                title: "Free limit reached",
                message:
                  "Subscribe to OpenCode Go for reliable access to the best open-source models.",
                label: "Subscribe",
                link: "https://opencode.ai/go",
              },
            },
          },
        },
        activeRef,
      );
    });

    expect(await screen.findByRole("dialog")).toHaveTextContent("Free limit reached");
    expect(screen.getByRole("dialog")).toHaveTextContent("Subscribe to OpenCode Go");
    expect(screen.getByRole("link", { name: "Subscribe" })).toHaveAttribute(
      "href",
      "https://opencode.ai/go",
    );
    expect(screen.getByRole("button", { name: "Don't show again" })).toBeInTheDocument();
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByText("Waiting to retry")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Don't show again" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("bloxbot:usage-limit:free-tier:hidden")).toBe("true");
  });

  it("SSE session.created adds a new session to the sidebar", async () => {
    const s1 = makeSession("s1", "Existing Session");
    const client = createClient();
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [s1] });

    render(<TestApp client={client} queryClient={queryClient} />);
    expect(await screen.findByText("Existing Session")).toBeInTheDocument();

    // Simulate a session being created elsewhere (e.g. from OpenCode CLI)
    const activeRef = { current: null };
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "session.created",
          properties: {
            info: makeSession("s2", "New From CLI"),
          },
        } as never,
        activeRef,
      );
    });

    // The new session should appear in the sidebar (no filter — all sessions shown)
    await waitFor(() => {
      expect(screen.getByText("New From CLI")).toBeInTheDocument();
    });
  });
});
