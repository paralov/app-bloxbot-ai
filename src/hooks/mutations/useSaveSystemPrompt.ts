import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

/** Saves the user's system prompt, or null for the default, and has OpenCode pick it up. */
export function useSaveSystemPrompt() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string | null>({
    mutationFn: async (systemPrompt) => {
      await desktop.setSystemPrompt(systemPrompt);
      await client?.instance.dispose({}, { throwOnError: true });
    },
    onSuccess: (_data, systemPrompt) => {
      posthog.capture(
        "system_prompt_changed",
        analyticsProperties("settings", { customized: systemPrompt !== null }),
      );
      return queryClient.invalidateQueries({ queryKey: qk.config });
    },
  });
}
