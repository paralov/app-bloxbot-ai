/**
 * Component tests for ChatInput.
 *
 * Tests message submission, image attachment validation,
 * model selection, and send/abort button states.
 */

import type { Session, SessionStatus } from "@opencode-ai/sdk/v2/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatInput from "@/components/ChatInput";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import { ActiveSessionContext } from "@/providers/ActiveSessionProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSession(id: string, title: string): Session {
  return {
    id,
    title,
    time: { created: Date.now(), updated: Date.now() },
    version: 1,
    parentID: "",
  } as Session;
}

function createClient(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      get: vi.fn().mockResolvedValue({ data: null }),
      create: vi.fn().mockResolvedValue({ data: null }),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({ data: null }),
      abort: vi.fn().mockResolvedValue({}),
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
                "claude-3.5-sonnet": { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
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
    question: { list: vi.fn().mockResolvedValue({ data: [] }), reply: vi.fn(), reject: vi.fn() },
    permission: { list: vi.fn().mockResolvedValue({ data: [] }), reply: vi.fn() },
    event: { subscribe: vi.fn().mockResolvedValue({ stream: null }) },
    app: { agents: vi.fn().mockResolvedValue({ data: [] }) },
    mcp: { connect: vi.fn(), disconnect: vi.fn() },
    instance: { dispose: vi.fn() },
  };
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
}

function seedState(qc: QueryClient, session: Session) {
  qc.setQueryData(qk.sessions, [session]);
  qc.setQueryData(qk.statuses, {});
  qc.setQueryData(qk.agents, []);
  qc.setQueryData(qk.providers, {
    all: [
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: { "claude-3.5-sonnet": { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" } },
      },
    ],
    connected: ["anthropic"],
    default: { anthropic: "claude-3.5-sonnet" },
  });
  qc.setQueryData(qk.config, {
    lastModel: "anthropic/claude-3.5-sonnet",
    hiddenModels: [],
    theme: "system",
  });
  qc.setQueryData<MessagesCache>(qk.messages(session.id), { messageIds: [], messagesById: {} });
  qc.setQueryData(qk.todos(session.id), []);
  qc.setQueryData(qk.questions, null);
  qc.setQueryData(qk.permissions, null);
}

/**
 * Wrapper that renders ChatInput with all required providers.
 * Pre-selects a session so the input is active.
 */
function TestChatInput({
  client,
  queryClient,
  sessionId = "s1",
  clientStatus = "ready",
}: {
  client: ReturnType<typeof createClient>;
  queryClient: QueryClient;
  sessionId?: string;
  clientStatus?: string;
}) {
  const activeSessionIdRef = useRef<string | null>(sessionId);
  const session = makeSession(sessionId, "Test Session");
  seedState(queryClient, session);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <OpenCodeClientContext.Provider
          value={{
            client: client as never,
            status: clientStatus as "waiting" | "ready" | "error",
            port: 4096,
            ready: clientStatus === "ready",
            initError: null,
          }}
        >
          <ActiveSessionContext.Provider
            value={{
              activeSessionId: sessionId,
              selectSession: async () => {},
              clearSession: () => {},
              activeSessionIdRef,
            }}
          >
            <PreferencesProvider>
              <ChatInput />
              <Toaster />
            </PreferencesProvider>
          </ActiveSessionContext.Provider>
        </OpenCodeClientContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("ChatInput", () => {
  it("sends a text message on submit", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Build a game" } });
    });

    const sendBtn = screen.getByTitle("Send");
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    expect(client.session.promptAsync).toHaveBeenCalled();
    const args = client.session.promptAsync.mock.calls[0][0];
    expect(args.parts[0].text).toBe("Build a game");
    expect(args.sessionID).toBe("s1");
  });

  it("sends message on Enter key (without Shift)", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });

    expect(client.session.promptAsync).toHaveBeenCalled();
  });

  it("does NOT send on Shift+Enter (allows newline)", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("disables send button when textarea is empty", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const sendBtn = await screen.findByTitle("Send");
    expect(sendBtn).toBeDisabled();
  });

  it("clears textarea after sending", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = (await screen.findByPlaceholderText(
      "Describe what you want to build...",
    )) as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Test message" } });
    });
    expect(textarea.value).toBe("Test message");

    await act(async () => {
      fireEvent.click(screen.getByTitle("Send"));
    });

    expect(textarea.value).toBe("");
  });

  it("does not send when text is only whitespace", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "   " } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("shows Stop button when session is busy", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    // Set busy *after* render so seedState doesn't overwrite
    act(() => {
      qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });
    });

    await waitFor(() => {
      expect(screen.getByTitle("Stop")).toBeInTheDocument();
    });
  });

  it("does not send when session is busy", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    // Set busy after render
    act(() => {
      qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });
    });

    const textarea = await screen.findByPlaceholderText("Describe what you want to build...");

    await act(async () => {
      fireEvent.change(textarea, { target: { value: "Hello" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("shows model selector with current model display", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    // Should show the model name (the part after the slash)
    await waitFor(() => {
      expect(screen.getByText("claude-3.5-sonnet")).toBeInTheDocument();
    });
  });

  it("shows Shift+Enter hint", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    await waitFor(() => {
      expect(screen.getByText("Shift+Enter for new line")).toBeInTheDocument();
    });
  });

  it("attaches an image to the submitted message", async () => {
    const client = createClient();
    const qc = createQueryClient();

    const { container } = render(<TestChatInput client={client} queryClient={qc} />);
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    if (!fileInput) throw new Error("Image file input was not rendered");

    const image = new File(["image contents"], "reference.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [image] } });
    });

    expect(await screen.findByText("reference.png")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledOnce());
    expect(client.session.promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "s1",
        parts: [
          { type: "text", text: " " },
          {
            type: "file",
            mime: "image/png",
            url: expect.stringMatching(/^data:image\/png;base64,/),
            filename: "reference.png",
          },
        ],
      }),
    );
  });
});
