import type { MessageWithParts } from "@/types";

export interface PlaytestPlan {
  goal: string;
  steps: string[];
  watchFor: string[];
  successCriteria: string[];
}

export const PLAYTEST_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "steps", "watchFor", "successCriteria"],
  properties: {
    goal: { type: "string", minLength: 1 },
    steps: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    watchFor: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    successCriteria: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
} as const;

function nonEmptyStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const strings = value
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim());
  return strings.length === value.length && strings.every(Boolean) ? strings : null;
}

export function parsePlaytestPlan(value: unknown): PlaytestPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The planner returned an invalid test plan.");
  }
  const candidate = value as Record<string, unknown>;
  const goal = typeof candidate.goal === "string" ? candidate.goal.trim() : "";
  const steps = nonEmptyStrings(candidate.steps);
  const watchFor = nonEmptyStrings(candidate.watchFor);
  const successCriteria = nonEmptyStrings(candidate.successCriteria);
  if (!goal || !steps || !watchFor || !successCriteria) {
    throw new Error("The planner returned an incomplete test plan.");
  }
  return { goal, steps, watchFor, successCriteria };
}

/** The chat has no text for the planner to read. */
export class NoPlaytestContextError extends Error {
  constructor() {
    super("Add some chat context before creating a playtest.");
    this.name = "NoPlaytestContextError";
  }
}

/**
 * The planner's model call failed. `modelErrorName` is OpenCode's error name,
 * such as APIError. `attempts` is how many replies the planner got.
 */
export class PlaytestPlannerError extends Error {
  constructor(
    message: string,
    readonly modelErrorName: string,
    readonly attempts = 1,
  ) {
    super(message);
    this.name = "PlaytestPlannerError";
  }
}

/** The planner answered without a usable plan, after `attempts` replies. */
export class InvalidPlaytestPlanError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "InvalidPlaytestPlanError";
  }
}

/** A generated plan and how many replies it took. */
export interface GeneratedPlaytestPlan {
  plan: PlaytestPlan;
  attempts: number;
}

/** The first reply plus one reminder when it has no plan. */
export const MAX_PLAYTEST_PLAN_ATTEMPTS = 2;

/** Sent in the same planning session when a reply has no valid plan. */
export const PLAYTEST_PLAN_REMINDER =
  "Your last reply did not include a valid plan. Answer only by calling the StructuredOutput tool once with the complete plan.";

/** Whether a chat has any text a playtest plan can be built from. */
export function hasPlaytestContext(messages: MessageWithParts[]): boolean {
  return messages.some(({ parts }) =>
    parts.some((part) => part.type === "text" && part.text.trim() !== ""),
  );
}

export function buildPlaytestHistory(messages: MessageWithParts[]): string {
  const entries = messages.flatMap(({ info, parts }) => {
    const text = parts
      .filter(
        (part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text",
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    return text ? [`${info.role === "user" ? "User" : "Assistant"}: ${text}`] : [];
  });
  return entries.join("\n\n").slice(-30_000);
}

export function formatPlaytestPrompt(plan: PlaytestPlan): string {
  const section = (title: string, items: string[]) =>
    `${title}:\n${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`;
  return [
    "Run this playtest in the currently connected Roblox Studio experience. Use the tools available to you as appropriate, observe the results, and report what passed, failed, or needs follow-up. Do not change the experience unless a test step explicitly requires it.",
    `Goal:\n${plan.goal}`,
    section("Steps", plan.steps),
    section("Watch for", plan.watchFor),
    section("Success criteria", plan.successCriteria),
  ].join("\n\n");
}
