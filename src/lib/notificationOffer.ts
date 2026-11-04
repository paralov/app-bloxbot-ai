import { loadConfig, patchConfig } from "@/lib/config";
import { notify } from "@/lib/notifications";

/**
 * A Mac only asks for permission when the first notification is sent. Left alone, that's while the
 * user is away and the notification is lost, so this asks once, while they're here to answer.
 */
export async function offerNotificationsOnce(): Promise<void> {
  if (!/Mac/.test(navigator.platform)) return;
  const { notificationsOffered, notificationKinds, systemNotifications } = await loadConfig();
  if (notificationsOffered) return;
  const wanted = notificationKinds
    ? Object.values(notificationKinds).some(Boolean)
    : systemNotifications;
  if (!wanted) return;
  notify.message("Get a ping when BloxBot's done?", {
    name: "notification_offer",
    id: "notification-offer",
    className: "card-toast",
    description: "Handy while you work in Studio.",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Turn on", onClick: () => void notify.test() },
    cancel: { label: "Not now", onClick: () => {} },
  });
  // Saved only once it is on screen, so a failure to show it leaves the ask for a later turn.
  await patchConfig({ notificationsOffered: true });
}
