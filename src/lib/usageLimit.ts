import { isFreeUsageLimit, type ModelError } from "@/lib/modelError";

export interface OpenCodeUsageAction {
  reason: "free_tier_limit" | "account_rate_limit";
  provider: "opencode" | "opencode-go";
  title: string;
  message: string;
  label: string;
  link?: string;
}

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
