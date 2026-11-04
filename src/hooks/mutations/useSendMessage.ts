import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  aiTracer,
  analyticsProperties,
  detailedAnalyticsProperties,
  errorAnalyticsProperties,
} from "@/lib/analytics";
import { offerNotificationsOnce } from "@/lib/notificationOffer";
import type { SessionStatus } from "@/lib/opencode/types";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import { recordPromptSent } from "@/lib/starCallout";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

interface SendMessageInput {
  text: string;
  images?: Array<{ mime: string; url: string; filename?: string }>;
  studioTargetReference?: string | null;
}

interface SendMessageContext {
  sessionID: string;
  previousStatus: SessionStatus | undefined;
}

export function useSendMessage(options?: { onError?: (error: Error) => void }) {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const { selectedModel, selectedVariant } = usePreferences();
  const queryClient = useQueryClient();

  return useMutation<void, Error, SendMessageInput, SendMessageContext | undefined>({
    mutationFn: async ({ text, images, studioTargetReference }: SendMessageInput) => {
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
      if (studioTargetReference) opts.system = studioTargetReference;
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

      if (selectedVariant) opts.variant = selectedVariant;

      aiTracer.beginTurn({
        sessionID: activeSessionId,
        text,
        imageCount: images?.length ?? 0,
        provider,
        model,
        variant: selectedVariant ?? undefined,
      });
      try {
        const accepted = client.session.promptAsync(
          opts as unknown as Parameters<typeof client.session.promptAsync>[0],
          {
            throwOnError: true,
          },
        );
        // Waiting on a reply is when a ping starts to sound useful.
        offerNotificationsOnce().catch((error) => {
          console.warn("Failed to offer notifications:", error);
        });
        recordPromptSent(accepted).catch((error) => {
          console.warn("Failed to count the prompt:", error);
        });
        await accepted;
      } catch (error) {
        aiTracer.cancelTurn(activeSessionId);
        throw error;
      }
      posthog.capture(
        "message_sent",
        analyticsProperties(
          "chat",
          detailedAnalyticsProperties({
            outcome: "success",
            has_images: Boolean(images?.length),
            has_studio_target: Boolean(studioTargetReference),
            provider,
            model,
          }),
        ),
      );
    },
    onMutate: () => {
      if (!activeSessionId) return undefined;
      const statuses = queryClient.getQueryData<Record<string, SessionStatus>>(qk.statuses);
      const context: SendMessageContext = {
        sessionID: activeSessionId,
        previousStatus: statuses?.[activeSessionId],
      };
      queryClient.setQueryData<Record<string, SessionStatus>>(qk.statuses, (previous) => ({
        ...previous,
        [activeSessionId]: { type: "busy" },
      }));
      return context;
    },
    onError: (error, input, context) => {
      options?.onError?.(error);
      posthog.capture(
        "message_send_failed",
        errorAnalyticsProperties("chat", "send_message", error, {
          has_images: Boolean(input.images?.length),
          has_studio_target: Boolean(input.studioTargetReference),
        }),
      );
      if (!context) return;
      queryClient.setQueryData<Record<string, SessionStatus>>(qk.statuses, (previous) => {
        if (previous?.[context.sessionID]?.type !== "busy") return previous;
        const next = { ...previous };
        if (context.previousStatus) {
          next[context.sessionID] = context.previousStatus;
        } else {
          delete next[context.sessionID];
        }
        return next;
      });
    },
  });
}
