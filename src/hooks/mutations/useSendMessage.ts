import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";

import { detailedAnalyticsProperties } from "@/lib/analytics";
import { splitModelKey } from "@/lib/splitModelKey";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

interface SendMessageInput {
  text: string;
  images?: Array<{ mime: string; url: string; filename?: string }>;
}

export function useSendMessage() {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const { selectedModel, selectedAgent, selectedVariant } = usePreferences();
  const posthog = usePostHog();

  return useMutation({
    mutationFn: async ({ text, images }: SendMessageInput) => {
      if (!client || !activeSessionId) throw new Error("No client or session");

      const parts: Array<{ type: string; [k: string]: unknown }> = [{ type: "text", text }];
      if (images) {
        for (const img of images) {
          parts.push({ type: "file", mime: img.mime, url: img.url, filename: img.filename });
        }
      }
      const opts: Record<string, unknown> = {
        sessionID: activeSessionId,
        parts,
      };
      let provider: string | undefined;
      let model: string | undefined;

      if (selectedModel) {
        const [providerID, modelID] = splitModelKey(selectedModel);
        if (providerID && modelID) {
          provider = providerID;
          model = modelID;
          opts.model = { providerID, modelID };
        }
      }

      if (selectedAgent) opts.agent = selectedAgent;
      if (selectedVariant) opts.variant = selectedVariant;

      await client.session.promptAsync(opts as Parameters<typeof client.session.promptAsync>[0]);
      posthog.capture(
        "message_sent",
        detailedAnalyticsProperties({
          provider,
          model,
          agent: selectedAgent ?? undefined,
        }),
      );
    },
  });
}
