import type { Session } from "@/lib/opencode/types";

export function isVisibleSession(session: Session): boolean {
  return session.metadata?.bloxbotHidden !== true;
}
