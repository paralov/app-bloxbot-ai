/**
 * Component tests for ChatInput.
 *
 * Tests message submission, image attachment validation,
 * model selection, and send/abort button states.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatInput, { savedDrafts } from "@/components/ChatInput";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { desktop } from "@/lib/desktop";
import { type ExplorerTreeUpdate, OBJECT_DRAG_NAME_TYPE, OBJECT_DRAG_TYPE } from "@/lib/explorer";
import type { Session, SessionStatus } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import type { MessagesCache } from "@/lib/sseDispatch";
import { ActiveSessionContext } from "@/providers/ActiveSessionProvider";
import {
  ExplorerReferenceProvider,
  useExplorerReference,
} from "@/providers/ExplorerReferenceProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

const studio = vi.hoisted(() => ({
  selected: null as { key: string } | null,
  sendBlock: null as string | null,
}));
vi.mock("@/providers/StudioTargetProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/providers/StudioTargetProvider")>()),
  useStudioTargetOptional: () => studio,
}));

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
      delete: vi.fn().mockResolvedValue({ data: true }),
      update: vi.fn().mockResolvedValue({ data: null }),
      abort: vi.fn().mockResolvedValue({ data: true }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
      status: vi.fn().mockResolvedValue({ data: {} }),
      todo: vi.fn().mockResolvedValue({ data: [] }),
      promptAsync: vi.fn().mockResolvedValue({}),
      command: vi.fn().mockResolvedValue({}),
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
    command: { list: vi.fn().mockResolvedValue({ data: [] }) },
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
    detailedAnalytics: "disabled",
    analyticsNoticeVersion: 2,
  });
  qc.setQueryData<MessagesCache>(qk.messages(session.id), { messageIds: [], messagesById: {} });
  qc.setQueryData(qk.todos(session.id), []);
  qc.setQueryData(qk.questions(session.id), null);
  qc.setQueryData(qk.permissions(session.id), null);
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
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
  client: ReturnType<typeof createClient>;
  queryClient: QueryClient;
  sessionId?: string;
  clientStatus?: string;
}) {
  const activeSessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    activeSessionIdRef.current = sessionId;
  }, [sessionId]);
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
              <ExplorerReferenceProvider>
                <ChatInput onOpenSettings={onOpenSettings} />
                <ReferenceButton />
                <Toaster />
              </ExplorerReferenceProvider>
            </PreferencesProvider>
          </ActiveSessionContext.Provider>
        </OpenCodeClientContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const PART = {
  name: "Part",
  className: "Part",
  path: "game.Workspace.Part",
  hasChildren: false,
  properties: [],
  attributes: [],
  children: [],
};

/** What Explorer's right-click action does, and the objects its sync shares. */
function ReferenceButton() {
  const { referenceObject } = useExplorerReference();
  return (
    <>
      <button type="button" onClick={() => referenceObject(PART)}>
        Reference Part
      </button>
      <button
        type="button"
        onClick={() => referenceObject({ ...PART, field: { kind: "property", name: "Anchored" } })}
      >
        Reference Anchored
      </button>
    </>
  );
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  studio.selected = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("ChatInput", () => {
  beforeEach(() => savedDrafts.clear());

  it("sends a text message on submit", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByRole("textbox", { name: "Message" });

    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Build a game" } });
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

  it("offers a way to add providers and models from the model picker", async () => {
    const onOpenSettings = vi.fn();
    const client = createClient();
    const queryClient = createQueryClient();
    render(
      <TestChatInput client={client} queryClient={queryClient} onOpenSettings={onOpenSettings} />,
    );
    await screen.findByRole("textbox", { name: "Message" });

    fireEvent.click(screen.getByRole("button", { name: /Select model|GPT|Claude/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add providers and models" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Add providers and models" }),
    ).not.toBeInTheDocument();
  });

  it("adds a referenced property as a chip that names it", async () => {
    const client = createClient();
    render(<TestChatInput client={client} queryClient={createQueryClient()} />);
    await screen.findByRole("textbox", { name: "Message" });

    fireEvent.click(screen.getByRole("button", { name: "Reference Anchored" }));

    expect(await screen.findByText("@Part.Anchored")).toHaveAttribute(
      "title",
      `Property of ${PART.path}`,
    );
    await act(async () => {
      fireEvent.click(screen.getByTitle("Send"));
    });
    expect(client.session.promptAsync.mock.calls[0][0].parts[0].text).toBe(
      '<Instance reference="game.Workspace.Part" property="Anchored">@Part.Anchored</Instance>',
    );
  });

  it("adds an object dragged from Explorer as a chip", async () => {
    studio.selected = { key: "studio-1" };
    let send: (update: ExplorerTreeUpdate) => void = () => {};
    vi.spyOn(desktop, "onExplorerTreeUpdate").mockImplementation((listener) => {
      send = listener;
      return () => {};
    });
    vi.spyOn(desktop, "syncExplorerTree").mockImplementation(async (studioId) => {
      send({ studioId, parentId: null, children: [PART] });
      return {
        changed: true,
        watching: false,
        complete: true,
        truncated: false,
        slowestReadMs: 0,
      };
    });
    render(<TestChatInput client={createClient()} queryClient={createQueryClient()} />);
    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect(desktop.syncExplorerTree).toHaveBeenCalled());
    // An object only offers itself once the tree has been read.
    await act(async () => {});

    const composer = textbox.closest("[data-composer]") as Element;
    const dataTransfer = {
      types: [OBJECT_DRAG_TYPE],
      files: [],
      dropEffect: "none",
      getData: (type: string) => (type === OBJECT_DRAG_TYPE ? PART.path : ""),
    };
    fireEvent.dragEnter(composer, { dataTransfer });
    expect(screen.getByText("Drop to reference this object...")).toBeInTheDocument();
    fireEvent.dragOver(composer, { dataTransfer });
    fireEvent.drop(composer, { dataTransfer });

    expect(await screen.findByText("@Part")).toHaveAttribute("title", PART.path);
    expect(screen.queryByText("Drop to reference this object...")).not.toBeInTheDocument();
  });

  it("takes an object dragged from Explorer before the message box has heard of it", async () => {
    render(<TestChatInput client={createClient()} queryClient={createQueryClient()} />);
    const textbox = await screen.findByRole("textbox", { name: "Message" });
    const composer = textbox.closest("[data-composer]") as Element;
    const dataTransfer = {
      types: [OBJECT_DRAG_TYPE],
      files: [],
      dropEffect: "none",
      getData: (type: string) =>
        type === OBJECT_DRAG_TYPE
          ? "game.Workspace.Model.La.te"
          : type === OBJECT_DRAG_NAME_TYPE
            ? "La.te"
            : "",
    };
    fireEvent.dragEnter(composer, { dataTransfer });
    fireEvent.drop(composer, { dataTransfer });

    expect(await screen.findByText("@La.te")).toHaveAttribute(
      "title",
      "game.Workspace.Model.La.te",
    );
  });

  it("adds Explorer's Reference as the same chip and text as an @ mention", async () => {
    const client = createClient();

    render(<TestChatInput client={client} queryClient={createQueryClient()} />);
    await screen.findByRole("textbox", { name: "Message" });

    fireEvent.click(screen.getByRole("button", { name: "Reference Part" }));

    expect(await screen.findByText("@Part")).toHaveAttribute("title", "game.Workspace.Part");
    await act(async () => {
      fireEvent.click(screen.getByTitle("Send"));
    });
    expect(client.session.promptAsync.mock.calls[0][0].parts[0].text).toBe(
      '<Instance reference="game.Workspace.Part">@Part</Instance>',
    );
  });

  it("sends message on Enter key (without Shift)", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByRole("textbox", { name: "Message" });

    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Hello" } });
      await Promise.resolve();
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });

    expect(client.session.promptAsync).toHaveBeenCalled();
  });

  it("does NOT send on Shift+Enter (allows newline)", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = await screen.findByRole("textbox", { name: "Message" });

    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Hello" } });
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it("restores the draft and status when sending fails", async () => {
    const client = createClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("Prompt rejected")),
    });
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    const textarea = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    act(() => {
      qc.setQueryData(qk.statuses, { s1: { type: "idle" } as SessionStatus });
    });

    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Keep this draft" } });
      await Promise.resolve();
      fireEvent.click(screen.getByTitle("Send"));
    });

    await waitFor(() => expect(textarea).toHaveTextContent("Keep this draft"));
    expect(qc.getQueryData<Record<string, SessionStatus>>(qk.statuses)?.s1.type).toBe("idle");
  });

  it("does not restore a failed send into a different session", async () => {
    let rejectPrompt: (error: Error) => void = () => {};
    const client = createClient({
      promptAsync: vi.fn().mockImplementation(() => {
        const pending = new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        });
        void pending.catch(() => undefined);
        return pending;
      }),
    });
    const qc = createQueryClient();
    const view = render(<TestChatInput client={client} queryClient={qc} sessionId="s1" />);

    const textarea = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Session one draft" } });
      fireEvent.click(screen.getByTitle("Send"));
    });

    view.rerender(<TestChatInput client={client} queryClient={qc} sessionId="s2" />);
    await act(async () => {
      rejectPrompt(new Error("Prompt rejected"));
      await Promise.resolve();
    });

    expect(textarea).not.toHaveTextContent("Session one draft");
    expect(screen.queryByText("Message not sent")).not.toBeInTheDocument();
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

  it("marks a successfully aborted session idle without refetching", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    act(() => {
      qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });
    });

    const stopButton = await screen.findByTitle("Stop");
    await act(async () => {
      fireEvent.click(stopButton);
    });

    await waitFor(() => {
      expect(qc.getQueryData<Record<string, SessionStatus>>(qk.statuses)?.s1.type).toBe("idle");
    });
    expect(client.session.abort).toHaveBeenCalledWith({ sessionID: "s1" }, { throwOnError: true });
  });

  it("won't send while this chat's place is closed, keeping what was typed", async () => {
    studio.sendBlock = "Dungeon isn't open. Reopen it or choose another.";
    try {
      const client = createClient();
      render(<TestChatInput client={client} queryClient={createQueryClient()} />);
      const textarea = await screen.findByRole("textbox", { name: "Message" });

      await act(async () => {
        fireEvent.input(textarea, { target: { textContent: "Delete everything" } });
      });
      expect(screen.getByTitle("Dungeon isn't open. Reopen it or choose another.")).toBeDisabled();

      await act(async () => {
        fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
      });

      expect(client.session.promptAsync).not.toHaveBeenCalled();
      expect(textarea).toHaveTextContent("Delete everything");

      // Commands that don't set the agent to work still run.
      await act(async () => {
        fireEvent.input(textarea, { target: { textContent: "/connect" } });
      });
      expect(screen.getByTitle("Send")).toBeEnabled();
    } finally {
      studio.sendBlock = null;
    }
  });

  it("keeps what was typed when something else takes over the screen for a while", async () => {
    const client = createClient();
    const qc = createQueryClient();
    const { unmount } = render(<TestChatInput client={client} queryClient={qc} />);
    const textarea = await screen.findByRole("textbox", { name: "Message" });
    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Build a lobby" } });
    });
    unmount();

    render(<TestChatInput client={client} queryClient={createQueryClient()} />);
    expect(await screen.findByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Build a lobby",
    );
  });

  it("does not send when session is busy", async () => {
    const client = createClient();
    const qc = createQueryClient();

    render(<TestChatInput client={client} queryClient={qc} />);

    // Set busy after render
    act(() => {
      qc.setQueryData(qk.statuses, { s1: { type: "busy" } as SessionStatus });
    });

    const textarea = await screen.findByRole("textbox", { name: "Message" });

    await act(async () => {
      fireEvent.input(textarea, { target: { textContent: "Hello" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });

    expect(client.session.promptAsync).not.toHaveBeenCalled();
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
      { throwOnError: true },
    );
  });
});
