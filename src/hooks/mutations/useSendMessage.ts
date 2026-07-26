import type { SessionStatus } from "@opencode-ai/sdk/v2/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { useStudioAssignments } from "@/hooks/useStudioAssignments";
import { detailedAnalyticsProperties } from "@/lib/analytics";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";
import {
  applyStudioPermissionRouting,
  prepareAutomaticStudioPermissionRouting,
  prepareStudioPromptRouting,
} from "@/lib/studioRouting";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

interface SendMessageInput {
  text: string;
  images?: Array<{ mime: string; url: string; filename?: string }>;
}

interface SendMessageContext {
  sessionID: string;
  previousStatus: SessionStatus | undefined;
}

export function useSendMessage() {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const { selectedModel, selectedAgent, selectedVariant } = usePreferences();
  const { assignments } = useStudioAssignments();
  const queryClient = useQueryClient();

  return useMutation<void, Error, SendMessageInput, SendMessageContext | undefined>({
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
      const studioAssignment = assignments[activeSessionId];
      if (studioAssignment) {
        const routing = await prepareStudioPromptRouting(client, activeSessionId, studioAssignment);
        opts.system = routing.system;
        await applyStudioPermissionRouting(client, activeSessionId, routing.permissions);
      } else {
        const permissions = await prepareAutomaticStudioPermissionRouting(client);
        await applyStudioPermissionRouting(client, activeSessionId, permissions);
      }
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

      await client.session.promptAsync(opts as Parameters<typeof client.session.promptAsync>[0], {
        throwOnError: true,
      });
      posthog.capture(
        "message_sent",
        detailedAnalyticsProperties({
          provider,
          model,
        }),
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
    onError: (_error, _input, context) => {
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
