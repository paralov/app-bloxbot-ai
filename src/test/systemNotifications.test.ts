import { describe, expect, it, vi } from "vitest";

import { createSystemNotifier, notificationSettingsUrl } from "../../electron/systemNotifications";

function fakeNotification() {
  const listeners = new Map<string, () => void>();
  return {
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    show: vi.fn(),
    emit: (event: string) => listeners.get(event)?.(),
  };
}

const input = { id: "1", title: "Hello", body: "There" };

describe("createSystemNotifier", () => {
  const notifier = (notification: ReturnType<typeof fakeNotification>, answerTimeoutMs?: number) =>
    createSystemNotifier({
      isSupported: () => true,
      create: () => notification,
      onClick: vi.fn(),
      answerTimeoutMs,
    });

  it("says it was shown once the system shows it", async () => {
    const notification = fakeNotification();
    const answer = notifier(notification)(input);
    notification.emit("show");
    await expect(answer).resolves.toBe(true);
  });

  it("says it wasn't when the system refuses, as a Mac does until the user allows it", async () => {
    const notification = fakeNotification();
    const answer = notifier(notification)(input);
    notification.emit("failed");
    await expect(answer).resolves.toBe(false);
  });

  it("doesn't wait forever on a system that never answers", async () => {
    await expect(notifier(fakeNotification(), 1)(input)).resolves.toBe(true);
  });

  it("says no without trying when the system has no notifications", async () => {
    const create = vi.fn();
    await expect(
      createSystemNotifier({ isSupported: () => false, create, onClick: vi.fn() })(input),
    ).resolves.toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("runs the click handler", async () => {
    const notification = fakeNotification();
    const onClick = vi.fn();
    const answer = createSystemNotifier({
      isSupported: () => true,
      create: () => notification,
      onClick,
    })(input);
    notification.emit("show");
    await answer;
    notification.emit("click");
    expect(onClick).toHaveBeenCalledWith("1");
  });
});

describe("notificationSettingsUrl", () => {
  it("knows each system's page, and has nothing for the rest", () => {
    expect(notificationSettingsUrl("darwin", "ai.bloxbot.desktop")).toBe(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=ai.bloxbot.desktop",
    );
    expect(notificationSettingsUrl("win32", "ai.bloxbot.desktop")).toBe(
      "ms-settings:notifications",
    );
    expect(notificationSettingsUrl("linux", "ai.bloxbot.desktop")).toBeNull();
  });
});
