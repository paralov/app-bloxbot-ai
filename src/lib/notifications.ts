import posthog from "posthog-js/dist/module.full.no-external.js";
import { type ExternalToast, toast } from "sonner";

import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";

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

let systemNotificationsEnabled = true;
let nextSystemId = 0;
let unsubscribeFromClicks: (() => void) | undefined;
const clickHandlers = new Map<string, () => void>();

export function setSystemNotificationsAllowed(enabled: boolean): void {
  systemNotificationsEnabled = enabled;
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
      if (shown) captureShown(name, "system");
      else clickHandlers.delete(id);
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
  if (system && systemNotificationsEnabled && !isWindowFocused()) {
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
    if (!systemNotificationsEnabled || isWindowFocused()) {
      showToast();
      return;
    }
    void showSystem(name, title, { body: description, onClick: open?.onClick }).then((shown) => {
      if (!shown) showToast();
    });
  },
  dismiss: (id: ToastId): void => {
    toast.dismiss(id);
  },
};
