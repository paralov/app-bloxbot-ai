import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

type RetryStatus = Extract<SessionStatus, { type: "retry" }>;
type RetryAction = NonNullable<RetryStatus["action"]>;

export type OpenCodeUsageAction = RetryAction & {
  reason: "free_tier_limit" | "account_rate_limit";
  provider: "opencode" | "opencode-go";
};

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
