import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";

// OpenCode allows 30 seconds for Claude Code to start, and 30 more to read its models.
const CHECK_MS = 65_000;

export type ExternalLoginResult =
  | { state: "ready" }
  | { state: "timeout" }
  | { state: "abandoned" }
  | { state: "problem"; message: string };

/** Connects a login OpenCode doesn't hold, like Claude Code's, and waits for OpenCode's check of it. */
export function useExternalLogin() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();

  return useCallback(
    async (
      providerID: string,
      methodIndex: number,
      abandoned: () => boolean,
    ): Promise<ExternalLoginResult> => {
      if (!client) return { state: "abandoned" };
      const options = { throwOnError: true as const };
      try {
        await client.auth.connectExternal({ providerID, methodIndex }, options);
      } catch (cause) {
        return {
          state: "problem",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
      try {
        const deadline = Date.now() + CHECK_MS;
        let looksReady = false;
        while (!abandoned()) {
          const { data } = await client.auth.externalStatus({ providerID }, options);
          if (data?.state === "problem") return { state: "problem", message: data.message };
          // A signed-out Claude Code still lists its models and the problem arrives separately,
          // so read again before treating the models as a working login, as OpenCode does.
          if (data?.state === "ready" && looksReady) return { state: "ready" };
          looksReady = data?.state === "ready";
          if (Date.now() > deadline) return { state: "timeout" };
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return { state: "abandoned" };
      } catch (cause) {
        return {
          state: "problem",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      } finally {
        // The connection is saved by now, even if the user has left the dialog.
        await queryClient.invalidateQueries({ queryKey: qk.providers });
      }
    },
    [client, queryClient],
  );
}
