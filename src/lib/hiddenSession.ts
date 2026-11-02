import type { OpencodeClient } from "./opencode/client";
import type { PermissionRuleset } from "./opencode/types";

/**
 * Permissions for a hidden helper session whose tools must never run. Every
 * tool needs approval, and `rejectPermissions` rejects every request, so
 * nothing runs. "deny" would be simpler but drops the tools from the request,
 * which OpenCode's free tier and Go reject.
 */
export const ASK_ALL_PERMISSIONS: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "ask" },
];

export const PERMISSION_POLL_MS = 250;

// OpenCode ends the turn on a bare rejection. With a reason, the model reads it and carries on.
const TOOLS_UNAVAILABLE = "Tools aren't available here. Answer in text.";

/**
 * Rejects every approval request from one session until stopped. Hidden
 * sessions never show approval prompts, so without this a tool call would
 * leave the session waiting forever.
 */
export function rejectPermissions(client: OpencodeClient, sessionID: string): () => void {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const pending = await client.permission.list({}).catch(() => undefined);
      for (const request of pending?.data ?? []) {
        if (request.sessionID !== sessionID) continue;
        await client.permission
          .reply({ requestID: request.id, reply: "reject", message: TOOLS_UNAVAILABLE })
          .catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, PERMISSION_POLL_MS));
    }
  })();
  return () => {
    stopped = true;
  };
}
