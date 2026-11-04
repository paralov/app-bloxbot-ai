interface SystemNotification {
  on(event: "show" | "click" | "close" | "failed", listener: () => void): unknown;
  show(): void;
}

interface SystemNotificationDeps {
  readonly isSupported: () => boolean;
  readonly create: (content: { title: string; body: string }) => SystemNotification;
  readonly onClick: (id: string) => void;
  /** How long to wait for the OS, which can be showing its permission dialog. */
  readonly answerTimeoutMs?: number;
}

const ANSWER_TIMEOUT_MS = 30_000;

/** Resolves to false when the OS won't show it, for example if the user hasn't allowed BloxBot. */
export function createSystemNotifier({
  isSupported,
  create,
  onClick,
  answerTimeoutMs = ANSWER_TIMEOUT_MS,
}: SystemNotificationDeps) {
  // Electron drops the click handler of a notification that gets garbage collected.
  const shown = new Set<SystemNotification>();

  return (input: { id: string; title: string; body: string }): Promise<boolean> => {
    if (!isSupported()) return Promise.resolve(false);
    const notification = create({ title: input.title, body: input.body });
    const release = () => shown.delete(notification);
    shown.add(notification);
    return new Promise((resolve) => {
      // No answer means no refusal, and some systems never report that one was shown.
      const timer = setTimeout(() => resolve(true), answerTimeoutMs);
      const answer = (allowed: boolean) => {
        clearTimeout(timer);
        resolve(allowed);
      };
      notification.on("show", () => answer(true));
      notification.on("click", () => {
        release();
        onClick(input.id);
      });
      notification.on("close", release);
      notification.on("failed", () => {
        release();
        answer(false);
      });
      notification.show();
    });
  };
}

/** Where each system lets people allow notifications. Elsewhere there's no one place to send them. */
export function notificationSettingsUrl(platform: NodeJS.Platform, appId: string): string | null {
  if (platform === "darwin") {
    return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${appId}`;
  }
  if (platform === "win32") return "ms-settings:notifications";
  return null;
}
