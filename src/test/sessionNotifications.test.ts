import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Session } from "@/lib/opencode/types";

const { attention, focused, maybeShowStarCallout } = vi.hoisted(() => ({
  attention: vi.fn(),
  focused: vi.fn(() => false),
  maybeShowStarCallout: vi.fn(async () => {}),
}));

vi.mock("@/lib/notifications", () => ({
  isWindowFocused: focused,
  notify: { attention },
}));
vi.mock("@/lib/starCallout", () => ({ maybeShowStarCallout }));

import { qk } from "@/lib/queryKeys";
import { SessionNotifier, setChatOnScreen } from "@/lib/sessionNotifications";

const event = (type: string, properties: Record<string, unknown>) =>
  ({ type, properties }) as unknown as Event;
const busy = (sessionID: string) =>
  event("session.status", { sessionID, status: { type: "busy" } });
const idleStatus = (sessionID: string) =>
  event("session.status", { sessionID, status: { type: "idle" } });
const idle = (sessionID: string) => event("session.idle", { sessionID });

describe("SessionNotifier", () => {
  let notifier: SessionNotifier;
  let queryClient: QueryClient;
  const active = { current: "chat" as string | null };
  const send = (...events: Event[]) => {
    for (const item of events) notifier.handleEvent(queryClient, item, active);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    focused.mockReturnValue(false);
    setChatOnScreen(true);
    active.current = "chat";
    notifier = new SessionNotifier();
    queryClient = new QueryClient();
    queryClient.setQueryData<Partial<Session>[]>(qk.sessions, [
      { id: "chat", title: "Build a castle" },
      { id: "other", title: "Fix the door" },
      { id: "subagent", title: "Search", parentID: "chat" },
      { id: "helper", title: "Plan", metadata: { bloxbotHidden: true } },
    ]);
  });

  it("announces a finished turn once in the background", () => {
    send(busy("chat"), idleStatus("chat"), idle("chat"));

    expect(attention).toHaveBeenCalledOnce();
    expect(attention).toHaveBeenCalledWith(
      "Chat finished",
      expect.objectContaining({ description: "Build a castle" }),
    );
    expect(maybeShowStarCallout).toHaveBeenCalledOnce();
  });

  it("stays quiet about the chat on screen but announces others", () => {
    focused.mockReturnValue(true);

    send(busy("chat"), idle("chat"));
    expect(attention).not.toHaveBeenCalled();

    send(busy("other"), idle("other"));
    expect(attention).toHaveBeenCalledOnce();
  });

  it("announces the active chat while another screen covers it", () => {
    focused.mockReturnValue(true);
    setChatOnScreen(false);

    send(busy("chat"), idle("chat"));

    expect(attention).toHaveBeenCalledOnce();
  });

  it("ignores idle events without a turn, hidden helper chats and subagents", () => {
    send(
      idle("chat"),
      busy("hidden"),
      idle("hidden"),
      busy("subagent"),
      idle("subagent"),
      busy("helper"),
      idle("helper"),
    );

    expect(attention).not.toHaveBeenCalled();
    expect(maybeShowStarCallout).not.toHaveBeenCalled();
  });

  it("reports an error instead of a finish, and nothing for a stopped chat", () => {
    send(
      busy("chat"),
      event("session.error", { sessionID: "chat", error: { name: "UnknownError" } }),
      idle("chat"),
    );
    expect(attention).toHaveBeenCalledOnce();
    expect(attention).toHaveBeenCalledWith(
      "Chat ran into a problem",
      expect.objectContaining({ tone: "error" }),
    );

    attention.mockClear();
    send(
      busy("chat"),
      event("session.error", { sessionID: "chat", error: { name: "MessageAbortedError" } }),
      idle("chat"),
    );
    expect(attention).not.toHaveBeenCalled();
  });

  it("announces questions and approval requests", () => {
    send(event("question.asked", { sessionID: "chat" }));
    send(event("permission.asked", { sessionID: "chat" }));

    expect(attention.mock.calls.map(([title]) => title)).toEqual([
      "BloxBot has a question",
      "BloxBot needs your approval",
    ]);
  });
});
