import type { OpencodeClient, PermissionRuleset } from "@opencode-ai/sdk/v2/client";

/**
 * Permissions for a hidden helper session whose tools must never run. Every
 * tool needs approval, and `rejectPermissions` rejects every request, so
 * nothing runs. "deny" would be simpler but drops the tools from the request,
 * which OpenCode's free tier and Go reject, and it also drops the
 * StructuredOutput tool OpenCode adds for `format: json_schema` prompts.
 */
export const ASK_ALL_PERMISSIONS: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "ask" },
];

export const PERMISSION_POLL_MS = 250;

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
        await client.permission.reply({ requestID: request.id, reply: "reject" }).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, PERMISSION_POLL_MS));
    }
  })();
  return () => {
    stopped = true;
  };
}
