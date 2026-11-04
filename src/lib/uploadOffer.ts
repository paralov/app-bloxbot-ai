import { loadConfig, patchConfig } from "@/lib/config";
import { notify } from "@/lib/notifications";
import { requestSettings } from "@/lib/settingsRequest";

/**
 * Importing by hand works, so nobody needs a key to get started. Once someone has seen a second
 * model they know what the manual step costs, so this offers uploads then, and only ever once.
 */
export async function offerUploadsOnce(modelUrl: string): Promise<void> {
  const { firstModelShown, uploadsOffered } = await loadConfig();
  if (uploadsOffered) return;
  if (!firstModelShown) {
    await patchConfig({ firstModelShown: modelUrl });
    return;
  }
  if (firstModelShown === modelUrl) return;
  notify.message("Skip the import step?", {
    name: "upload_offer",
    id: "upload-offer",
    className: "card-toast",
    description:
      "BloxBot can upload models for you, after you check each one. It needs a key from Roblox, and we'll walk you through it.",
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Set it up", onClick: () => requestSettings("uploads") },
    cancel: { label: "Not now", onClick: () => {} },
  });
  await patchConfig({ uploadsOffered: true });
}
