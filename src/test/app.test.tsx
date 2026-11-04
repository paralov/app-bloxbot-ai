/**
 * The real component tree on a mocked client, for states that are hard to reach
 * against the real server. workflows.test.tsx covers what people do end to end.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useRef } from "react";
import { toast } from "sonner";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { desktop } from "@/lib/desktop";
import type { Session } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import { type MessagesCache, sseDispatch } from "@/lib/sseDispatch";
import { ActiveSessionProvider } from "@/providers/ActiveSessionProvider";
import { ExplorerReferenceProvider } from "@/providers/ExplorerReferenceProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";
import { StudioTargetProvider } from "@/providers/StudioTargetProvider";

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
  withStudioTargets = false,
}: {
  client: ReturnType<typeof createClient>;
  queryClient: QueryClient;
  withStudioTargets?: boolean;
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
                {withStudioTargets ? (
                  <StudioTargetProvider>
                    <ChatWithSonner />
                  </StudioTargetProvider>
                ) : (
                  <ChatWithSonner />
                )}
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
    command: { list: vi.fn().mockResolvedValue({ data: [] }) },
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
  opts: {
    sessions?: Session[];
    detailedAnalytics?: "unset" | "enabled" | "disabled";
    analyticsNoticeVersion?: number;
  } = {},
) {
  const sessions = opts.sessions ?? [];

  queryClient.setQueryData(qk.sessions, sessions);
  queryClient.setQueryData(qk.statuses, {});
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
    analyticsNoticeVersion: opts.analyticsNoticeVersion ?? 2,
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
  // Settings loads on first open, and on a slow machine that outlasts findBy's wait.
  beforeAll(() => import("@/components/Settings"), 60_000);

  it("enables usage metrics by default, notifies once, and keeps opting out toggleable", async () => {
    const client = createClient();
    const queryClient = createQueryClient();
    // An old clickaway ("disabled" without a notice version) does not carry over.
    seedReadyState(queryClient, { detailedAnalytics: "disabled", analyticsNoticeVersion: 0 });

    render(<TestApp client={client} queryClient={queryClient} />);

    const noticeTitle = await screen.findByText("BloxBot shares AI usage data");
    expect(noticeTitle).toBeVisible();
    expect(noticeTitle.closest("[data-sonner-toast]")).toHaveClass("card-toast");
    await expect(desktop.loadConfig()).resolves.toMatchObject({
      detailedAnalytics: "enabled",
      analyticsNoticeVersion: 2,
    });
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    fireEvent.click(await screen.findByText("Settings"));
    fireEvent.click(await screen.findByRole("button", { name: "Privacy" }));
    const analyticsSwitch = screen.getByRole("switch", {
      name: "Share AI usage data",
    });
    expect(analyticsSwitch).toHaveAttribute("aria-checked", "true");

    fireEvent.click(analyticsSwitch);

    expect(analyticsSwitch).toHaveAttribute("aria-checked", "false");
    await expect(desktop.loadConfig()).resolves.toMatchObject({ detailedAnalytics: "disabled" });
  });

  it("keeps an earlier opt-out without showing the AI usage notice", async () => {
    const client = createClient();
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { detailedAnalytics: "disabled", analyticsNoticeVersion: 1 });

    render(<TestApp client={client} queryClient={queryClient} />);

    await waitFor(() =>
      expect(desktop.loadConfig()).resolves.toMatchObject({ analyticsNoticeVersion: 2 }),
    );
    expect(screen.queryByText("BloxBot shares AI usage data")).not.toBeInTheDocument();
    await expect(desktop.loadConfig()).resolves.toMatchObject({
      detailedAnalytics: "disabled",
      analyticsNoticeVersion: 2,
    });
  });

  it("respects a recorded opt-out without renotifying", async () => {
    const client = createClient();
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { detailedAnalytics: "disabled", analyticsNoticeVersion: 2 });

    render(<TestApp client={client} queryClient={queryClient} />);

    fireEvent.click(await screen.findByText("Settings"));
    fireEvent.click(await screen.findByRole("button", { name: "Privacy" }));
    expect(screen.queryByText("BloxBot shares AI usage data")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "https://bloxbot.ai/privacy?utm_source=bloxbot&utm_medium=desktop_app&utm_campaign=app_links&utm_content=privacy",
    );
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
      "href",
      "https://bloxbot.ai/terms?utm_source=bloxbot&utm_medium=desktop_app&utm_campaign=app_links&utm_content=privacy",
    );
    expect(screen.getByRole("switch", { name: "Share AI usage data" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("shows the device ID to quote in a data request", async () => {
    const loaded = vi.spyOn(posthog, "__loaded", "get").mockReturnValue(true);
    const distinctId = vi.spyOn(posthog, "get_distinct_id").mockReturnValue("device-123");
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { detailedAnalytics: "disabled", analyticsNoticeVersion: 2 });

    try {
      render(<TestApp client={createClient()} queryClient={queryClient} />);

      fireEvent.click(await screen.findByText("Settings"));
      fireEvent.click(await screen.findByRole("button", { name: "Privacy" }));
      expect(screen.getByText("device-123")).toBeInTheDocument();
      expect(screen.getByText("support@bloxbot.ai")).toBeInTheDocument();
    } finally {
      loaded.mockRestore();
      distinctId.mockRestore();
    }
  });

  it("links to Paralov, Studs.gg and the legal pages from About", async () => {
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { detailedAnalytics: "disabled", analyticsNoticeVersion: 2 });

    render(<TestApp client={createClient()} queryClient={queryClient} />);

    fireEvent.click(await screen.findByText("Settings"));
    fireEvent.click(await screen.findByRole("button", { name: "About" }));
    const utm =
      "?utm_source=bloxbot&utm_medium=desktop_app&utm_campaign=app_links&utm_content=about";
    for (const [name, url] of [
      ["Website", "https://bloxbot.ai/"],
      ["Paralov", "https://paralov.com/"],
      ["Studs.gg", "https://studs.gg/"],
      ["Privacy Policy", "https://bloxbot.ai/privacy"],
      ["Terms of Service", "https://bloxbot.ai/terms"],
    ]) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", `${url}${utm}`);
    }
  });

  it("lets someone skip Studio setup, and doesn't ask again", async () => {
    const client = createClient();
    client.mcp.status = vi
      .fn()
      .mockResolvedValue({ data: { "roblox-studio": { status: "failed" } } });
    client.mcp.connect = vi.fn().mockResolvedValue({});
    const queryClient = createQueryClient();
    seedReadyState(queryClient);

    try {
      const { unmount } = render(<TestApp client={client} queryClient={queryClient} />);
      fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "Let's connect Studio" })).toBeNull(),
      );
      await expect(desktop.loadConfig()).resolves.toMatchObject({ studioSetupSkipped: true });
      // Nobody has a chat yet, and they've just said they're ready to start.
      expect(client.session.create).toHaveBeenCalledTimes(1);
      unmount();

      render(<TestApp client={client} queryClient={queryClient} />);
      expect(await screen.findByText("What would you like to build?")).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Let's connect Studio" })).toBeNull();
    } finally {
      await desktop.patchConfig({ studioSetupSkipped: false });
    }
  });

  it("leaves setup when someone picks a chat from the sidebar", async () => {
    const session = makeSession("s1", "Older chat");
    const client = createClient({
      get: vi.fn().mockResolvedValue({ data: session }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    client.mcp.status = vi
      .fn()
      .mockResolvedValue({ data: { "roblox-studio": { status: "failed" } } });
    client.mcp.connect = vi.fn().mockResolvedValue({});
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    render(<TestApp client={client} queryClient={queryClient} />);
    expect(await screen.findByRole("heading", { name: "Let's connect Studio" })).toBeVisible();

    fireEvent.click(screen.getByText("Older chat"));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Let's connect Studio" })).toBeNull(),
    );
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeVisible();
  });

  it("finishes first-run setup when a Studio appears, with no chat open", async () => {
    const discover = vi
      .spyOn(desktop, "discoverStudioTargets")
      .mockResolvedValue({ targets: [], selectedKey: null } as never);
    const client = createClient();
    const studioStatus = vi
      .fn()
      .mockResolvedValue({ data: { "roblox-studio": { status: "failed" } } });
    client.mcp.status = studioStatus;
    client.mcp.connect = vi.fn().mockResolvedValue({});
    const queryClient = createQueryClient();
    seedReadyState(queryClient);

    try {
      render(<TestApp client={client} queryClient={queryClient} withStudioTargets />);
      expect(await screen.findByRole("heading", { name: "Let's connect Studio" })).toBeVisible();

      studioStatus.mockResolvedValue({ data: { "roblox-studio": { status: "connected" } } });
      discover.mockResolvedValue({
        targets: [{ key: "studio-1", label: "My Place", detail: "Local place" }],
        selectedKey: null,
      } as never);
      fireEvent.click(screen.getByRole("button", { name: "Check now" }));

      expect(
        await screen.findByRole("heading", { name: "Studio connected" }, { timeout: 4_000 }),
      ).toBeVisible();
    } finally {
      discover.mockRestore();
    }
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
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));

    expect(await screen.findByRole("heading", { name: "Studio connected" })).toBeVisible();
  });

  it("walks through setup from the picker until a Studio appears, with a way back", async () => {
    const discover = vi
      .spyOn(desktop, "discoverStudioTargets")
      .mockResolvedValue({ targets: [], selectedKey: null } as never);
    const session = makeSession("s1", "My Session");
    const never = new Promise<never>(() => {});
    const client = createClient({
      get: vi.fn().mockReturnValue(never),
      messages: vi.fn().mockReturnValue(never),
      todo: vi.fn().mockReturnValue(never),
    });
    const queryClient = createQueryClient();
    seedReadyState(queryClient, { sessions: [session] });

    try {
      render(<TestApp client={client} queryClient={queryClient} withStudioTargets />);
      const openSetup = async () => {
        fireEvent.click(await screen.findByRole("button", { name: /No Studio/ }));
        // The picker and the notice over the message box both offer it.
        fireEvent.click(screen.getAllByRole("button", { name: "Show me how" })[0] as HTMLElement);
      };

      fireEvent.click(await screen.findByText("My Session"));
      await openSetup();

      // The helper is connected, but with no Studio listed setup isn't done.
      expect(await screen.findByRole("heading", { name: "Let's connect Studio" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Studio connected" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
      await openSetup();
      expect(await screen.findByRole("heading", { name: "Let's connect Studio" })).toBeVisible();

      discover.mockResolvedValue({
        targets: [{ key: "studio-1", label: "My Place", detail: "Local place" }],
        selectedKey: "studio-1",
      } as never);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      fireEvent.click(screen.getByRole("button", { name: "Check now" }));

      expect(await screen.findByRole("heading", { name: "Studio connected" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Let's build" }));
      expect(await screen.findByRole("button", { name: /My Place/ })).toBeVisible();
    } finally {
      discover.mockRestore();
    }
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
    const textarea = await screen.findByRole("textbox", { name: "Message" });

    // Type and send a message
    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Build me a Roblox game" } });
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
    await screen.findByRole("textbox", { name: "Message" });

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
      expect(screen.getByText("Running")).toBeInTheDocument();
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
      expect(screen.queryByText("Running")).not.toBeInTheDocument();
    });
  });

  it("ends the turn at the free limit with the reason and a way to keep going", async () => {
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
    await screen.findByRole("textbox", { name: "Message" });

    const activeRef = { current: "s1" };
    act(() => {
      sseDispatch(
        queryClient,
        { type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } },
        activeRef,
      );
    });

    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "session.error",
          properties: {
            sessionID: "s1",
            error: {
              name: "APIError",
              data: {
                message: "Free usage limit reached.",
                retryAfterMs: 2 * 60 * 60 * 1000,
                isRetryable: false,
              },
            },
          },
        },
        activeRef,
      );
    });

    expect(await screen.findByText("You've used today's free messages")).toBeInTheDocument();

    // The failed reply has no content, and it must not look like it's still thinking.
    act(() => {
      sseDispatch(
        queryClient,
        {
          type: "message.updated",
          properties: {
            sessionID: "s1",
            info: {
              id: "reply",
              sessionID: "s1",
              role: "assistant",
              time: { created: Date.now(), completed: Date.now() },
              parentID: "prompt",
              modelID: "m",
              providerID: "p",
              mode: "studio",
              agent: "studio",
              path: { cwd: "", root: "" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              error: {
                name: "APIError",
                data: {
                  message: "Free usage limit reached.",
                  retryAfterMs: 2 * 60 * 60 * 1000,
                },
              },
            },
          },
        } as never,
        activeRef,
      );
    });
    await waitFor(() =>
      expect(screen.queryAllByRole("status").every((status) => !status.textContent)).toBe(true),
    );
    expect(screen.getByRole("link", { name: "See OpenCode Go" })).toHaveAttribute(
      "href",
      "https://opencode.ai/go",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/They reset in about 2 hours/)).toBeInTheDocument();
  });
});
