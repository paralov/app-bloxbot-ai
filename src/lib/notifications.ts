import posthog from "posthog-js/dist/module.full.no-external.js";
import { type ExternalToast, toast } from "sonner";

import { analyticsProperties } from "@/lib/analytics";
import { playChime } from "@/lib/chime";
import { desktop } from "@/lib/desktop";
import type { NotificationKinds } from "@/types/desktop";

/**
 * Every message BloxBot shows the user goes through here, so one place decides how it reaches them.
 *
 * - `notify.message/success/error/loading` show a toast. Pass `system` for something that matters
 *   even when BloxBot is in the background, and it also goes to the OS while the window is unfocused.
 * - `notify.attention` is for things that happen on their own, like a chat finishing. It shows one
 *   of the two: a toast while the window is focused, otherwise an OS notification.
 *
 * Anything a user can click needs a `name`, which is how notification_shown and notification_clicked
 * tell notifications apart. Names are fixed strings: titles can hold versions and provider names.
 */

type ToastId = string | number;

export interface SystemOptions {
  /** Plain text for the OS notification. Defaults to the description when that is a string. */
  body?: string;
  /** Runs when the OS notification is clicked, after the window has been brought to the front. */
  onClick?: () => void;
}

interface PassiveNotifyOptions extends ExternalToast {
  name?: undefined;
  action?: undefined;
  cancel?: undefined;
  system?: undefined;
}

interface InteractiveNotifyOptions extends ExternalToast {
  name: string;
  system?: boolean | SystemOptions;
}

export type NotifyOptions = PassiveNotifyOptions | InteractiveNotifyOptions;

export interface AttentionOptions {
  name: string;
  description?: string;
  tone?: "default" | "error";
  /** Takes the user to whatever this is about, from the toast's button or the OS notification. */
  open?: { label: string; onClick: () => void };
}

export type NotificationKind = keyof NotificationKinds;

const ALL_KINDS: NotificationKinds = { finished: true, waiting: true, failed: true, app: true };

let enabledKinds: NotificationKinds = ALL_KINDS;
let soundEnabled = true;
let nextSystemId = 0;
let unsubscribeFromClicks: (() => void) | undefined;
const clickHandlers = new Map<string, () => void>();

export function setNotificationPreferences(kinds: NotificationKinds, sound: boolean): void {
  enabledKinds = kinds;
  soundEnabled = sound;
}

/** Linux has no one place that lists an app's notifications. */
export function canOpenNotificationSettings(): boolean {
  return /Mac|Win/.test(navigator.platform);
}

export function openNotificationSettings(): void {
  desktop.openNotificationSettings().catch((error) => {
    console.warn("Couldn't open the notification settings:", error);
  });
}

/** Which setting a notification falls under. Anything else is about the app itself. */
function kindOf(name: string): NotificationKind {
  if (name === "chat_finished") return "finished";
  if (name === "chat_failed") return "failed";
  if (name === "chat_question" || name === "chat_permission") return "waiting";
  return "app";
}

/** True while the user is looking at BloxBot rather than at Studio or another app. */
export function isWindowFocused(): boolean {
  return document.hasFocus();
}

type Output = "toast" | "system";

function captureShown(notification: string, output: Output): void {
  posthog.capture(
    "notification_shown",
    analyticsProperties("notifications", { notification, output }),
  );
}

function captureClicked(notification: string, output: Output, action: string): void {
  posthog.capture(
    "notification_clicked",
    analyticsProperties("notifications", { notification, output, action }),
  );
}

/** Reports clicks on a toast's action or cancel button, then does what the button does. */
function trackedButton<T extends ExternalToast["action"]>(notification: string, button: T): T {
  if (!button || typeof button !== "object" || !("onClick" in button)) return button;
  const { label, onClick } = button;
  return {
    ...button,
    onClick: (event: Parameters<typeof onClick>[0]) => {
      captureClicked(notification, "toast", typeof label === "string" ? label : "custom");
      onClick(event);
    },
  };
}

const MAX_CLICK_HANDLERS = 50;

/** Resolves to false when the OS has no notifications to offer, so a caller can use a toast. */
function showSystem(name: string, title: string, options: SystemOptions): Promise<boolean> {
  const id = String(++nextSystemId);
  clickHandlers.set(id, () => {
    captureClicked(name, "system", "open");
    options.onClick?.();
  });
  // A dismissed notification never reports back, so only recent ones stay clickable.
  if (clickHandlers.size > MAX_CLICK_HANDLERS) {
    clickHandlers.delete(clickHandlers.keys().next().value as string);
  }
  unsubscribeFromClicks ??= desktop.onSystemNotificationClick((clickedId) => {
    clickHandlers.get(clickedId)?.();
    clickHandlers.delete(clickedId);
  });
  return desktop.showSystemNotification({ id, title, body: options.body ?? "" }).then(
    (shown) => {
      if (shown) {
        captureShown(name, "system");
        // Only once the system has agreed, so a refused notification doesn't make a sound for nothing.
        if (soundEnabled) playChime();
      } else {
        clickHandlers.delete(id);
      }
      return shown;
    },
    (error) => {
      clickHandlers.delete(id);
      console.warn("System notification failed:", error);
      return false;
    },
  );
}

function withSystem(title: string, options: NotifyOptions | undefined): ExternalToast | undefined {
  if (!options) return undefined;
  const { name, system, ...toastOptions } = options;
  if (!name) return toastOptions;
  captureShown(name, "toast");
  if (system && enabledKinds[kindOf(name)] && !isWindowFocused()) {
    const systemOptions = system === true ? {} : system;
    void showSystem(name, title, {
      ...systemOptions,
      body:
        systemOptions.body ??
        (typeof options.description === "string" ? options.description : undefined),
    });
  }
  return {
    ...toastOptions,
    action: trackedButton(name, options.action),
    cancel: trackedButton(name, options.cancel),
  };
}

export const notify = {
  message: (title: string, options?: NotifyOptions): ToastId =>
    toast(title, withSystem(title, options)),
  success: (title: string, options?: NotifyOptions): ToastId =>
    toast.success(title, withSystem(title, options)),
  error: (title: string, options?: NotifyOptions): ToastId =>
    toast.error(title, withSystem(title, options)),
  loading: (title: string, options?: NotifyOptions): ToastId =>
    toast.loading(title, withSystem(title, options)),
  attention(title: string, { name, description, tone = "default", open }: AttentionOptions): void {
    const showToast = () => {
      captureShown(name, "toast");
      const show = tone === "error" ? toast.error : toast;
      show(title, { description, action: trackedButton(name, open) });
    };
    if (!enabledKinds[kindOf(name)] || isWindowFocused()) {
      showToast();
      return;
    }
    void showSystem(name, title, { body: description, onClick: open?.onClick }).then((shown) => {
      if (!shown) showToast();
    });
  },
  /**
   * Sends one the way a real one goes, whatever the settings and wherever the user is looking. On a
   * Mac, the first one is also what makes the system ask for permission.
   */
  async test(): Promise<void> {
    const shown = await showSystem("notification_test", "BloxBot notifications are working", {
      body: "This is how BloxBot gets your attention.",
    });
    if (shown) {
      toast.success("Test notification sent", {
        description: "Didn't see it? Check Focus or Do Not Disturb.",
      });
      return;
    }
    toast.error("Notifications are off for BloxBot", {
      description: "Turn them on in your computer's settings.",
      action: canOpenNotificationSettings()
        ? { label: "Open settings", onClick: openNotificationSettings }
        : undefined,
    });
  },
  dismiss: (id: ToastId): void => {
    toast.dismiss(id);
  },
};
