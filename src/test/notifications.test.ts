import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast, desktop, capture, click, playChime } = vi.hoisted(() => {
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
  return { toast, desktop, capture, click, playChime: vi.fn() };
});

vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/chime", () => ({ playChime }));
vi.mock("@/lib/desktop", () => ({ desktop }));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({ default: { capture } }));
vi.mock("@/lib/analytics", () => ({
  analyticsProperties: (feature: string, properties: object) => ({ feature, ...properties }),
}));

import { notify, setNotificationPreferences } from "@/lib/notifications";

const ALL = { finished: true, waiting: true, failed: true, app: true };

function setFocused(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setNotificationPreferences(ALL, false);
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
    setNotificationPreferences({ ...ALL, finished: false }, false);
    setFocused(false);

    notify.attention("Chat finished", { name: "chat_finished" });

    expect(toast).toHaveBeenCalledOnce();
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();
  });

  it("turns each kind off on its own", () => {
    setNotificationPreferences({ ...ALL, finished: false }, false);
    setFocused(false);

    notify.attention("BloxBot has a question", { name: "chat_question" });
    expect(desktop.showSystemNotification).toHaveBeenCalledOnce();

    desktop.showSystemNotification.mockClear();
    setNotificationPreferences({ ...ALL, waiting: false, app: false }, false);
    notify.attention("BloxBot needs your approval", { name: "chat_permission" });
    notify.error("Lost connection", { name: "connection_lost", system: true });
    expect(desktop.showSystemNotification).not.toHaveBeenCalled();
    notify.attention("Chat finished", { name: "chat_finished" });
    expect(desktop.showSystemNotification).toHaveBeenCalledOnce();
  });

  it("sends a test the way a real one goes, even in front or with every kind off", async () => {
    setNotificationPreferences(
      { finished: false, waiting: false, failed: false, app: false },
      true,
    );
    setFocused(true);

    await notify.test();

    expect(desktop.showSystemNotification).toHaveBeenCalledOnce();
    expect(playChime).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledOnce();
  });

  it("leaves the sound out of a test when it's off, and says if the OS refused", async () => {
    setFocused(true);
    desktop.showSystemNotification.mockResolvedValueOnce(false);

    await notify.test();

    expect(playChime).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Notifications are off for BloxBot",
      expect.objectContaining({ description: expect.stringContaining("settings") }),
    );
  });

  it("plays the chime with an OS notification, only if the user wants it", async () => {
    setFocused(false);
    notify.attention("Chat finished", { name: "chat_finished" });
    await vi.waitFor(() => expect(desktop.showSystemNotification).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(playChime).not.toHaveBeenCalled();

    setNotificationPreferences(ALL, true);
    notify.attention("Chat finished", { name: "chat_finished" });
    await vi.waitFor(() => expect(playChime).toHaveBeenCalledOnce());

    playChime.mockClear();
    setFocused(true);
    notify.attention("Chat finished", { name: "chat_finished" });
    await Promise.resolve();
    expect(playChime).not.toHaveBeenCalled();
  });

  it("stays quiet when the OS refuses the notification", async () => {
    setNotificationPreferences(ALL, true);
    setFocused(false);
    desktop.showSystemNotification.mockResolvedValueOnce(false);

    notify.attention("Chat finished", { name: "chat_finished" });

    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
    expect(playChime).not.toHaveBeenCalled();
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

  it("never sends the chat title to analytics", () => {
    setFocused(false);

    notify.attention("Chat finished", { name: "chat_finished", description: "Secret project" });

    expect(JSON.stringify(capture.mock.calls)).not.toContain("Secret project");
  });
});
