/**
 * Component tests for ChatSidebar.
 *
 * Tests session list rendering, create/delete/rename interactions,
 * and session filtering (BloxBot-only vs all).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatSidebar from "@/components/ChatSidebar";
import type { Session } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import { ActiveSessionProvider } from "@/providers/ActiveSessionProvider";
import { OpenCodeClientContext } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture, register: vi.fn() },
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeSession(
  id: string,
  title: string,
  createdAt = Date.now(),
  archived?: number,
): Session {
  return {
    id,
    title,
    time: { created: createdAt, updated: createdAt, archived },
    version: 1,
    parentID: "",
  } as Session;
}

function createClient(overrides: Record<string, unknown> = {}) {
  const list = vi.fn().mockResolvedValue({ data: [] });
  return {
    experimental: { session: { list } },
    session: {
      list,
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
  qc.setQueryData(qk.providers, { all: [], connected: [], default: {} });
  qc.setQueryData(qk.config, {
    lastModel: null,
    hiddenModels: [],
    theme: "system",
    detailedAnalytics: "disabled",
    analyticsNoticeVersion: 2,
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
  it("snoozes an idle session instead of deleting it", async () => {
    const s1 = makeSession("s1", "To Snooze");
    const snoozed = makeSession("s1", "To Snooze", s1.time.created, Date.now());
    const client = createClient({ update: vi.fn().mockResolvedValue({ data: snoozed }) });
    const qc = createQueryClient();
    seedState(qc, { sessions: [s1] });
    qc.setQueryData(qk.statuses, { s1: { type: "idle" } });

    render(<TestSidebar client={client} queryClient={qc} />);

    expect(await screen.findByText("To Snooze")).toBeInTheDocument();

    const snoozeBtn = screen.getByTitle("Snooze");
    await act(async () => {
      fireEvent.click(snoozeBtn);
    });

    await waitFor(() =>
      expect(client.session.update).toHaveBeenCalledWith(
        { sessionID: "s1", time: { archived: expect.any(Number) } },
        { throwOnError: true },
      ),
    );
    expect(client.session.delete).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByText("Snoozed")).toBeInTheDocument();
    });
    expect(capture).toHaveBeenCalledWith("session_snoozed", {
      analytics_schema_version: 1,
      feature: "sessions",
      outcome: "success",
    });
  });

  it("does not snooze a busy session", async () => {
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc, { sessions: [makeSession("s1", "Still working")] });
    qc.setQueryData(qk.statuses, { s1: { type: "busy" } });

    render(<TestSidebar client={client} queryClient={qc} />);

    const button = await screen.findByTitle("Wait for session to finish");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(client.session.update).not.toHaveBeenCalled();
  });

  it("opens a snoozed session without changing its archive timestamp", async () => {
    const snoozed = makeSession("s1", "A very long snoozed session title", Date.now(), Date.now());
    const client = createClient({ get: vi.fn().mockResolvedValue({ data: snoozed }) });
    const qc = createQueryClient();
    seedState(qc, { sessions: [snoozed] });
    const onSessionSelect = vi.fn();

    render(<TestSidebar client={client} queryClient={qc} onSessionSelect={onSessionSelect} />);
    fireEvent.click(await screen.findByText("Snoozed"));
    expect(capture).toHaveBeenCalledWith("snoozed_section_toggled", {
      analytics_schema_version: 1,
      expanded: true,
      count_bucket: "1",
      feature: "sessions",
    });
    await act(async () => {
      fireEvent.click(screen.getByTitle(`Open snoozed session ${snoozed.title}`));
    });

    expect(onSessionSelect).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith("snoozed_session_opened", {
      analytics_schema_version: 1,
      feature: "sessions",
    });
    expect(client.session.update).not.toHaveBeenCalled();
    expect(screen.getByText("Snoozed")).toBeInTheDocument();
  });

  it("permanently deletes a session only from its right-click menu and after confirmation", async () => {
    const snoozed = makeSession("s1", "Old session", Date.now(), Date.now());
    const client = createClient();
    const qc = createQueryClient();
    seedState(qc, { sessions: [snoozed] });

    render(<TestSidebar client={client} queryClient={qc} />);
    fireEvent.click(await screen.findByText("Snoozed"));
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTitle(`Open snoozed session ${snoozed.title}`));
    const deleteButton = screen.getByText("Delete");
    fireEvent.click(deleteButton);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Delete chat?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Cancel"));
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith("permanent_delete_requested", {
      analytics_schema_version: 1,
      feature: "sessions",
    });
    expect(capture).toHaveBeenCalledWith("permanent_delete_cancelled", {
      analytics_schema_version: 1,
      confirmed: false,
      feature: "sessions",
    });

    fireEvent.contextMenu(screen.getByTitle(`Open snoozed session ${snoozed.title}`));
    fireEvent.click(screen.getByText("Delete"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(capture).toHaveBeenCalledWith("permanent_delete_confirmed", {
      analytics_schema_version: 1,
      confirmed: true,
      feature: "sessions",
    });
    expect(client.session.delete).toHaveBeenCalledWith({ sessionID: "s1" }, { throwOnError: true });
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
});
