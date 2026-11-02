interface SystemNotification {
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
}

interface SystemNotificationDeps {
  readonly isSupported: () => boolean;
  readonly create: (content: { title: string; body: string }) => SystemNotification;
  readonly onClick: (id: string) => void;
}

export function createSystemNotifier({ isSupported, create, onClick }: SystemNotificationDeps) {
  // Electron drops the click handler of a notification that gets garbage collected.
  const shown = new Set<SystemNotification>();

  return (input: { id: string; title: string; body: string }): boolean => {
    if (!isSupported()) return false;
    const notification = create({ title: input.title, body: input.body });
    const release = () => shown.delete(notification);
    shown.add(notification);
    notification.on("click", () => {
      release();
      onClick(input.id);
    });
    notification.on("close", release);
    notification.on("failed", release);
    notification.show();
    return true;
  };
}
