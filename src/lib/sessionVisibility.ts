import type { Session } from "@opencode-ai/sdk/v2/client";

export function isVisibleSession(session: Session): boolean {
  return session.metadata?.bloxbotHidden !== true;
}
