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
