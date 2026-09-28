// Pure helpers for error reporting. Everything that leaves the device as part of an
// error report passes through `scrubErrorText`, so reports explain failures without
// carrying personal paths, usernames, or credentials. No runtime imports: the Electron
// main process uses this module too.

import type { MainErrorReport } from "../types/desktop";

export const ERROR_MESSAGE_MAX_LENGTH = 500;
export const ERROR_STACK_MAX_LENGTH = 4000;

export const REDACTED = "[redacted]";

export interface ScrubOptions {
  /** A known home directory to replace with `~`, e.g. the main process's `app.getPath("home")`. */
  home?: string;
  /** A known OS username to mask wherever it appears. */
  username?: string;
}

// `/Users/<name>`, `/home/<name>`, `C:\Users\<name>` and `C:/Users/<name>`, including
// JSON-escaped backslashes and `file:///` URLs. The name segment is captured.
// A preceding host or word character means a URL path such as `example.com/home/…`.
const HOME_PATH =
  /(?<![A-Za-z0-9.-])(?:[A-Za-z]:)?(?:\\{1,2}|\/)(?:Users|home)(?:\\{1,2}|\/)([^\\/\s"'`<>|:;,()[\]{}]+)/g;
// Windows account folders may contain spaces (`C:\Users\Jane Doe\…`, `C:/Users/Jane Doe/…`);
// matched up to the next separator or the end of the line.
const WINDOWS_HOME_PATH =
  /(?:(?:\b[A-Za-z]:)?\\{1,2}Users\\{1,2}|\b[A-Za-z]:\/Users\/)([^\\/\r\n"'`<>|:*?]+?)(?=[\\/]|$)/gm;

const SECRET_PATTERNS: ReadonlyArray<
  [RegExp, string | ((match: string, ...groups: string[]) => string)]
> = [
  // HTTP authorization values.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // `api_key=…`, `"token": "…"`, `password: …`, `x-api-key: …`.
  // Plain numbers are kept only for token counts such as `max_tokens: 4096`.
  [
    /\b((?:[A-Za-z]+[_-])*(?:api[_-]?key|apikey|token|secret|password|passwd|authorization|auth|credential)s?)(["']?\s*[:=]\s*["']?)(?!\[redacted\])([^\s"',;&)}]+)/gi,
    (_match: string, key: string, separator: string, value: string) =>
      /[_-]tokens$/i.test(key) && /^\d+$/.test(value)
        ? `${key}${separator}${value}`
        : `${key}${separator}${REDACTED}`,
  ],
  // Provider keys: OpenAI/Anthropic/OpenRouter (`sk-…`, `sk-ant-…`, `sk-or-…`), Google (`AIza…`),
  // GitHub (`ghp_…`, `github_pat_…`), Slack (`xox…`), AWS access keys, Groq (`gsk_…`), xAI (`xai-…`).
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\b(?:gsk|xai|pplx|hf|glpat|npm)[_-][A-Za-z0-9_-]{16,}/g, REDACTED],
  // Email addresses, such as the account a provider error names.
  [
    /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu,
    "<email>",
  ],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
];

// Long base64/hex-ish runs that mix letters and digits are treated as secrets.
const OPAQUE_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

function looksLikeSecret(candidate: string): boolean {
  // Paths are made of short segments; a secret is one long unbroken run.
  const longestSegment = Math.max(...candidate.split("/").map((segment) => segment.length));
  if (longestSegment < 32) return false;
  const digits = candidate.replace(/[^0-9]/g, "").length;
  const letters = candidate.replace(/[^A-Za-z]/g, "").length;
  return digits >= 4 && letters >= 4;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskName(text: string, name: string): string {
  if (name.length < 3) return text;
  return text.replace(
    new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "gi"),
    "<user>",
  );
}

/** Removes home directories, usernames and credentials from free text. Does not truncate. */
export function scrubErrorText(text: string, options: ScrubOptions = {}): string {
  let result = text;
  if (options.home && options.home.length > 1) {
    result = result.split(options.home).join("~");
  }
  const names = new Set<string>();
  if (options.username) names.add(options.username);
  const replaceHome = (_match: string, name: string) => {
    names.add(name);
    return "~";
  };
  result = result.replace(WINDOWS_HOME_PATH, replaceHome).replace(HOME_PATH, replaceHome);
  // The username found in a path often appears elsewhere, e.g. in a hostname or email.
  for (const name of names) result = maskName(result, name);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result =
      typeof replacement === "string"
        ? result.replace(pattern, replacement)
        : result.replace(pattern, replacement);
  }
  return result.replace(OPAQUE_TOKEN, (candidate) =>
    looksLikeSecret(candidate) ? REDACTED : candidate,
  );
}

export function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Scrubs and truncates a message for an error report. */
export function scrubErrorMessage(
  text: string,
  maxLength = ERROR_MESSAGE_MAX_LENGTH,
  options?: ScrubOptions,
): string {
  // Truncate generously first so a huge message never goes through every pattern.
  return truncateText(scrubErrorText(truncateText(text, maxLength * 4), options), maxLength);
}

function scrubDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return scrubErrorMessage(value, ERROR_STACK_MAX_LENGTH);
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubDeep(item, depth + 1)]),
  );
}

// Our own error properties and PostHog's flattened exception properties.
const MESSAGE_PROPERTIES = ["error_message", "$exception_message"] as const;
const LONG_TEXT_PROPERTIES = ["component_stack", "$exception_values"] as const;

interface ExceptionEntry {
  value?: unknown;
  [key: string]: unknown;
}

/**
 * Scrubs every property of a PostHog event that can carry error text: the
 * `$exception_list` of `$exception` events (messages and stack frames) and our own
 * `error_message`/`component_stack` properties. Returns the same shape.
 */
export function scrubEventProperties<P extends Record<string, unknown>>(properties: P): P {
  const scrubbed: Record<string, unknown> = { ...properties };
  const exceptionList = scrubbed.$exception_list;
  if (Array.isArray(exceptionList)) {
    scrubbed.$exception_list = exceptionList.map((entry: unknown) => {
      const clean = scrubDeep(entry, 0);
      if (
        clean &&
        typeof clean === "object" &&
        typeof (clean as ExceptionEntry).value === "string"
      ) {
        return {
          ...(clean as ExceptionEntry),
          value: truncateText((clean as ExceptionEntry).value as string, ERROR_MESSAGE_MAX_LENGTH),
        };
      }
      return clean;
    });
  }
  for (const key of MESSAGE_PROPERTIES) {
    if (typeof scrubbed[key] === "string") scrubbed[key] = scrubErrorMessage(scrubbed[key]);
  }
  for (const key of LONG_TEXT_PROPERTIES) {
    if (key in scrubbed) scrubbed[key] = scrubDeep(scrubbed[key], 0);
  }
  return scrubbed as P;
}

/**
 * Extracts a type name and message from anything thrown, including SDK error bodies. A
 * wrapping error's `cause` is appended, since wrappers usually say what failed and the
 * cause says why.
 */
export function describeError(error: unknown): { type: string; message: string | null } {
  const described = describeOne(error);
  const cause =
    error !== null && typeof error === "object" && "cause" in error
      ? describeOne((error as { cause: unknown }).cause)
      : null;
  if (cause?.message && described.message && !described.message.includes(cause.message)) {
    return { ...described, message: `${described.message} (cause: ${cause.message})` };
  }
  return described;
}

function describeOne(error: unknown): { type: string; message: string | null } {
  if (error instanceof Error) return { type: error.name, message: error.message };
  if (typeof error === "string") return { type: "string", message: error };
  if (error !== null && typeof error === "object") {
    // OpenCode SDK errors are plain objects: `{ name: "ProviderAuthError", data: { message } }`.
    const record = error as Record<string, unknown>;
    const data =
      record.data !== null && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : null;
    const type =
      typeof record.name === "string"
        ? record.name
        : typeof record._tag === "string"
          ? record._tag
          : "object";
    const message =
      typeof data?.message === "string"
        ? data.message
        : typeof record.message === "string"
          ? record.message
          : null;
    return { type, message };
  }
  return { type: typeof error, message: null };
}

/** Rebuilds an Error from a forwarded report so PostHog can parse its stack. */
export function errorFromMainReport(report: MainErrorReport): Error {
  const error = new Error(report.message);
  error.name = report.name || "Error";
  error.stack = report.stack ?? `${error.name}: ${report.message}`;
  return error;
}

/**
 * Returns a predicate that accepts a key at most once per window, so a failure in a loop
 * becomes one report instead of hundreds.
 */
export function createErrorDeduper(windowMs: number, now: () => number = Date.now) {
  const lastSeen = new Map<string, number>();
  return (key: string): boolean => {
    const time = now();
    const previous = lastSeen.get(key);
    if (previous !== undefined && time - previous < windowMs) return false;
    lastSeen.set(key, time);
    if (lastSeen.size > 200) {
      for (const [entry, seen] of lastSeen) {
        if (time - seen >= windowMs) lastSeen.delete(entry);
      }
    }
    return true;
  };
}
