import { useMutation, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";

import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

/** Saves what the user wants BloxBot to follow, and has OpenCode, which reads it once, pick it up. */
export function useSaveInstructions() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (text) => {
      await desktop.saveInstructions(text);
      await client?.instance.dispose({}, { throwOnError: true });
    },
    onSuccess: (_data, text) => {
      posthog.capture(
        "instructions_changed",
        analyticsProperties("settings", { empty: !text.trim() }),
      );
      return queryClient.invalidateQueries({ queryKey: qk.instructions });
    },
  });
}
