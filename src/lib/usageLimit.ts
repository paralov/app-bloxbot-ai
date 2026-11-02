import { isFreeUsageLimit, type ModelError } from "@/lib/modelError";
import type { SessionStatus } from "@/lib/opencode/types";

type RetryStatus = Extract<SessionStatus, { type: "retry" }>;
type RetryAction = NonNullable<RetryStatus["action"]>;

export type OpenCodeUsageAction = RetryAction & {
  reason: "free_tier_limit" | "account_rate_limit";
  provider: "opencode" | "opencode-go";
};

const OPENCODE_GO_URL = "https://opencode.ai/go";

/** OpenCode 2 ends the turn at the free limit, so the dialog can also start from that error. */
export function freeLimitUsageAction(error: ModelError | null): OpenCodeUsageAction | null {
  if (!error || !isFreeUsageLimit(error)) return null;
  return {
    reason: "free_tier_limit",
    provider: "opencode",
    title: "Free limit reached",
    message: "Subscribe to OpenCode Go for reliable access to the best open-source models.",
    label: "Subscribe",
    link: OPENCODE_GO_URL,
  };
}

export function getOpenCodeUsageAction(
  status: SessionStatus | undefined,
): OpenCodeUsageAction | null {
  if (status?.type !== "retry" || !status.action) return null;
  if (status.action.provider !== "opencode" && status.action.provider !== "opencode-go")
    return null;
  if (status.action.reason !== "free_tier_limit" && status.action.reason !== "account_rate_limit") {
    return null;
  }
  return status.action as OpenCodeUsageAction;
}
