/**
 * Component tests for ChatSidebar.
 *
 * Tests session list rendering, create/delete/rename interactions,
 * and session filtering (BloxBot-only vs all).
 */

import type { Session } from "@opencode-ai/sdk/v2/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatSidebar from "@/components/ChatSidebar";
import { qk } from "@/lib/queryKeys";
import { ActiveSessionProvider } from "@/providers/ActiveSessionProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

// ── Helpers ──────────────────────────────────────────────────────────

function makeSession(id: string, title: string, createdAt = Date.now()): Session {
  return {
    id,
    title,
    time: { created: createdAt, updated: createdAt },
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
      ...overrides,
    },
    provider: {
      list: vi.fn().mockResolvedValue({ data: { all: [], connected: [] } }),
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

function seedState(qc: QueryClient, opts: { sessions?: Session[] } = {}) {
  const sessions = opts.sessions ?? [];

  qc.setQueryData(qk.sessions, sessions);
  qc.setQueryData(qk.statuses, {});
  qc.setQueryData(qk.agents, []);
  qc.setQueryData(qk.providers, { all: [], connected: [], default: {} });
  qc.setQueryData(qk.config, {
    lastModel: null,
    hiddenModels: [],
    theme: "system",
    detailedAnalytics: "disabled",
  });
}

function TestSidebar({
  client,
  queryClient,
  collapsed = false,
  onToggle = vi.fn(),
  onSessionSelect = vi.fn(),
  onOpenSettings = vi.fn(),
}: {
  client: ReturnType<typeof createClient>;
  queryClient: QueryClient;
  collapsed?: boolean;
  onToggle?: () => void;
  onSessionSelect?: () => void;
  onOpenSettings?: () => void;
}) {
  const activeSessionIdRef = useRef<string | null>(null);
  return (
    <QueryClientProvider client={queryClient}>
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
            <ChatSidebar
              collapsed={collapsed}
              onToggle={onToggle}
              onSessionSelect={onSessionSelect}
              onOpenSettings={onOpenSettings}
            />
          </PreferencesProvider>
        </ActiveSessionProvider>
      </OpenCodeClientContext.Provider>
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

describe("ChatSidebar", () => {
  it("renders session list", async () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc, {
      sessions: [makeSession("s1", "Session Alpha"), makeSession("s2", "Session Beta")],
    });

    render(<TestSidebar client={client} queryClient={qc} />);

    expect(await screen.findByText("Session Alpha")).toBeInTheDocument();
    expect(screen.getByText("Session Beta")).toBeInTheDocument();
  });

  it("shows empty state when no sessions", async () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc);

    render(<TestSidebar client={client} queryClient={qc} />);

    expect(await screen.findByText(/No sessions yet/)).toBeInTheDocument();
  });

  it("calls session.create when New Session is clicked", async () => {
    const newSession = makeSession("new-1", "New Session");
    const client = createClient({
      create: vi.fn().mockResolvedValue({ data: newSession }),
      get: vi.fn().mockResolvedValue({ data: newSession }),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    });
    const qc = createQueryClient();
    seedState(qc);

    const onSessionSelect = vi.fn();
    render(<TestSidebar client={client} queryClient={qc} onSessionSelect={onSessionSelect} />);

    const newBtn = screen.getByTitle("New session");
    await act(async () => {
      fireEvent.click(newBtn);
    });

    expect(client.session.create).toHaveBeenCalled();
    expect(onSessionSelect).toHaveBeenCalled();
  });

  it("calls session.delete when Delete is clicked", async () => {
    const s1 = makeSession("s1", "To Delete");
    const client = createClient({ delete: vi.fn().mockResolvedValue({ data: true }) });
    const qc = createQueryClient();
    seedState(qc, { sessions: [s1] });
    qc.setQueryData(qk.statuses, { s1: { type: "idle" } });
    qc.setQueryData(qk.messages("s1"), { messageIds: [], messagesById: {} });
    qc.setQueryData(qk.todos("s1"), []);
    qc.setQueryData(qk.questions("s1"), null);
    qc.setQueryData(qk.permissions("s1"), null);

    render(<TestSidebar client={client} queryClient={qc} />);

    expect(await screen.findByText("To Delete")).toBeInTheDocument();

    const deleteBtn = screen.getByTitle("Delete");
    await act(async () => {
      fireEvent.click(deleteBtn);
    });

    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "s1" }, { throwOnError: true });

    await waitFor(() => {
      expect(screen.queryByText("To Delete")).not.toBeInTheDocument();
    });
    expect(qc.getQueryData(qk.messages("s1"))).toBeUndefined();
    expect(qc.getQueryData(qk.todos("s1"))).toBeUndefined();
    expect(qc.getQueryData(qk.questions("s1"))).toBeUndefined();
    expect(qc.getQueryData(qk.permissions("s1"))).toBeUndefined();
    expect(qc.getQueryData<Record<string, unknown>>(qk.statuses)).toEqual({});
  });

  it("enters rename mode and commits on Enter", async () => {
    const s1 = makeSession("s1", "Original Name");
    const renamed = makeSession("s1", "Renamed");
    const client = createClient({
      update: vi.fn().mockResolvedValue({ data: renamed }),
    });
    const qc = createQueryClient();
    seedState(qc, { sessions: [s1] });

    render(<TestSidebar client={client} queryClient={qc} />);

    expect(await screen.findByText("Original Name")).toBeInTheDocument();

    // Click rename button
    const renameBtn = screen.getByTitle("Rename");
    await act(async () => {
      fireEvent.click(renameBtn);
    });

    // An input should appear with the current title
    const input = screen.getByDisplayValue("Original Name");
    expect(input).toBeInTheDocument();

    // Type new name and press Enter
    await act(async () => {
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(client.session.update).toHaveBeenCalledWith(
      {
        sessionID: "s1",
        title: "Renamed",
      },
      { throwOnError: true },
    );
  });

  it("cancels rename on Escape", async () => {
    const s1 = makeSession("s1", "My Session");
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc, { sessions: [s1] });

    render(<TestSidebar client={client} queryClient={qc} />);

    const renameBtn = await screen.findByTitle("Rename");
    await act(async () => {
      fireEvent.click(renameBtn);
    });

    const input = screen.getByDisplayValue("My Session");
    await act(async () => {
      fireEvent.change(input, { target: { value: "Changed" } });
      fireEvent.keyDown(input, { key: "Escape" });
    });

    // Should not have called update
    expect(client.session.update).not.toHaveBeenCalled();
    // Should show original title
    expect(screen.getByText("My Session")).toBeInTheDocument();
  });

  it("calls onOpenSettings when Settings button is clicked", async () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc);

    const onOpenSettings = vi.fn();
    render(<TestSidebar client={client} queryClient={qc} onOpenSettings={onOpenSettings} />);

    const settingsBtn = await screen.findByText("Settings");
    await act(async () => {
      fireEvent.click(settingsBtn);
    });

    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows collapsed state with icon buttons", () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc);

    render(<TestSidebar client={client} queryClient={qc} collapsed />);

    expect(screen.getByTitle("Expand sidebar")).toBeInTheDocument();
    expect(screen.getByTitle("New session")).toBeInTheDocument();
    expect(screen.getByTitle("Settings")).toBeInTheDocument();
  });

  it("calls onToggle when collapse button is clicked", async () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc);

    const onToggle = vi.fn();
    render(<TestSidebar client={client} queryClient={qc} onToggle={onToggle} />);

    const collapseBtn = screen.getByTitle("Collapse sidebar");
    await act(async () => {
      fireEvent.click(collapseBtn);
    });

    expect(onToggle).toHaveBeenCalled();
  });
});
