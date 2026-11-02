import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast, desktop, capture, click } = vi.hoisted(() => {
  const capture = vi.fn();
  const click: { listener?: (id: string) => void } = {};
  const toast = Object.assign(
    vi.fn(() => "toast-id"),
    {
      success: vi.fn(() => "toast-id"),
      error: vi.fn(() => "toast-id"),
      loading: vi.fn(() => "toast-id"),
      dismiss: vi.fn(),
    },
  );
  const desktop = {
    showSystemNotification: vi.fn(async () => true),
    onSystemNotificationClick: vi.fn((listener: (id: string) => void) => {
      click.listener = listener;
      return () => {};
    }),
  };
  return { toast, desktop, capture, click };
});

vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/desktop", () => ({ desktop }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({ default: { capture } }));
vi.mock("@/lib/analytics", () => ({
  analyticsProperties: (feature: string, properties: object) => ({ feature, ...properties }),
}));

import { notify, setSystemNotificationsAllowed } from "@/lib/notifications";

function setFocused(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSystemNotificationsAllowed(true);
  });

  it("only shows a toast by default, even in the background", () => {
    setFocused(false);

    expect(notify.error("Message not sent", { description: "Nope" })).toBe("toast-id");

    expect(toast.error).toHaveBeenCalledWith("Message not sent", { description: "Nope" });
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();
  });

  it("adds an OS notification to a system toast while unfocused", () => {
    setFocused(false);

    notify.error("Lost connection", {
      name: "connection_lost",
      description: "Events stopped.",
      system: true,
    });

    expect(toast.error).toHaveBeenCalledWith(
      "Lost connection",
      expect.objectContaining({ description: "Events stopped." }),
    );
    expect(desktop.showSystemNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Lost connection", body: "Events stopped." }),
    );
  });

  it("keeps a system toast in the app while focused", () => {
    setFocused(true);

    notify.message("Update available", {
      name: "update_available",
      system: { body: "Open BloxBot." },
    });

    expect(toast).toHaveBeenCalledOnce();
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();
  });

  it("sends attention to one output, depending on focus", () => {
    setFocused(true);
    notify.attention("Chat finished", { name: "chat_finished", description: "Build a castle" });
    expect(toast).toHaveBeenCalledOnce();
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();

    toast.mockClear();
    setFocused(false);
    notify.attention("Chat finished", { name: "chat_finished", description: "Build a castle" });
    expect(toast).not.toHaveBeenCalled();
    expect(desktop.showSystemNotification).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Chat finished", body: "Build a castle" }),
    );
  });

  it("falls back to a toast when system notifications are turned off", () => {
    setSystemNotificationsAllowed(false);
    setFocused(false);

    notify.attention("Chat finished", { name: "chat_finished" });

    expect(toast).toHaveBeenCalledOnce();
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();
  });

  it("falls back to a toast when the OS can't show a notification", async () => {
    setFocused(false);
    desktop.showSystemNotification.mockResolvedValueOnce(false);

    notify.attention("Chat finished", { name: "chat_finished" });

    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
  });

  it("runs the open action once when its OS notification is clicked", () => {
    setFocused(false);
    const onClick = vi.fn();

    notify.attention("Chat finished", {
      name: "chat_finished",
      open: { label: "Open", onClick },
    });

    const { id } = desktop.showSystemNotification.mock.calls[0][0 as never] as { id: string };
    click.listener?.(id);
    click.listener?.(id);
    expect(onClick).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      "notification_clicked",
      expect.objectContaining({ notification: "chat_finished", output: "system", action: "open" }),
    );
  });

  it("reports an OS notification click even when it only brings the window forward", () => {
    setFocused(false);

    notify.error("Lost connection", { name: "connection_lost", system: true });

    const { id } = desktop.showSystemNotification.mock.calls[0][0 as never] as { id: string };
    click.listener?.(id);
    expect(capture).toHaveBeenCalledWith(
      "notification_clicked",
      expect.objectContaining({ notification: "connection_lost", output: "system" }),
    );
  });

  it("reports which toast button was clicked and still runs it", () => {
    setFocused(true);
    const onClick = vi.fn();

    notify.message("Enjoying BloxBot?", {
      name: "github_star",
      action: { label: "Star on GitHub", onClick },
    });

    expect(capture).toHaveBeenCalledWith(
      "notification_shown",
      expect.objectContaining({ notification: "github_star", output: "toast" }),
    );
    const options = toast.mock.calls[0][1 as never] as {
      action: { onClick: (event: unknown) => void };
    };
    options.action.onClick({});
    expect(onClick).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith(
      "notification_clicked",
      expect.objectContaining({
        notification: "github_star",
        output: "toast",
        action: "Star on GitHub",
      }),
    );
  });

  it("never sends the chat title to analytics", () => {
    setFocused(false);

    notify.attention("Chat finished", { name: "chat_finished", description: "Secret project" });

    expect(JSON.stringify(capture.mock.calls)).not.toContain("Secret project");
  });
});
