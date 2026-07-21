import type { Message, Part } from "@opencode-ai/sdk/v2/client";

// ── Chat types ──────────────────────────────────────────────────────────

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

/** Model info as returned by provider.list() */
export interface ModelInfo {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  status?: "alpha" | "beta" | "deprecated" | "active";
  variants?: Record<string, Record<string, unknown>>;
}

/** Provider info from the API */
export interface ProviderInfo {
  id: string;
  name: string;
  env: string[];
}
