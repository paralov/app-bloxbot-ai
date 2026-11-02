import { describe, expect, it, vi } from "vitest";

import { createSystemNotifier } from "../../electron/systemNotifications";

function fakeNotification() {
  const listeners = new Map<string, () => void>();
  return {
    on: (event: string, listener: () => void) => listeners.set(event, listener),
    show: vi.fn(),
    emit: (event: string) => listeners.get(event)?.(),
  };
}

describe("createSystemNotifier", () => {
  it("shows the notification and reports its id when clicked", () => {
    const notification = fakeNotification();
    const create = vi.fn(() => notification);
    const onClick = vi.fn();

    createSystemNotifier({ isSupported: () => true, create, onClick })({
      id: "7",
      title: "Chat finished",
      body: "Build a castle",
    });

    expect(create).toHaveBeenCalledWith({ title: "Chat finished", body: "Build a castle" });
    expect(notification.show).toHaveBeenCalledOnce();
    notification.emit("click");
    expect(onClick).toHaveBeenCalledWith("7");
  });

  it("does nothing where the OS has no notifications", () => {
    const create = vi.fn(() => fakeNotification());

    const shown = createSystemNotifier({ isSupported: () => false, create, onClick: vi.fn() })({
      id: "7",
      title: "Chat finished",
      body: "",
    });

    expect(shown).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
