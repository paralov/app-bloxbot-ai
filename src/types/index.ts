import type { Message, Part, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client";

// ── OpenCode sidecar status (from Rust backend) ─────────────────────────

/** Status of the OpenCode sidecar process (from Rust backend). */
export type OpenCodeStatus = "Stopped" | "Starting" | "Running" | { Error: string };

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
  cost?: { input: number; output: number };
  contextLimit?: number;
  variants?: Record<string, Record<string, unknown>>;
}

/** Provider info from the API */
export interface ProviderInfo {
  id: string;
  name: string;
  env: string[];
}

/** Auth methods keyed by provider ID */
export type AuthMethods = Record<string, ProviderAuthMethod[]>;

// ── Studio plugin connection status ──────────────────────────────────

/** Possible states of the roblox-studio MCP server as reported by OpenCode. */
export type StudioConnectionStatus =
  | "unknown"
  | "connected"
  | "disconnected"
  | "failed"
  | "disabled";
