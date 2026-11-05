import type { StudioTarget } from "@/types/studioTarget";

export const qk = {
  sessions: ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  messages: (id: string) => ["sessions", id, "messages"] as const,
  sessionError: (id: string) => ["sessions", id, "error"] as const,
  todos: (id: string) => ["sessions", id, "todos"] as const,
  goal: (id: string) => ["sessions", id, "goal"] as const,
  statuses: ["session-statuses"] as const,
  providers: ["providers"] as const,
  commands: ["commands"] as const,
  questions: (id: string) => ["sessions", id, "questions"] as const,
  permissions: (id: string) => ["sessions", id, "permissions"] as const,
  config: ["config"] as const,
  instructions: ["instructions"] as const,
  studioConnection: ["studio-connection"] as const,
  // Studio can hand the same key to another place, so the place's ID and name count too.
  uploadAccess: (studio: StudioTarget | null, modelUrl: string | null) =>
    [
      "uploadAccess",
      studio ? JSON.stringify([studio.key, studio.placeId ?? null, studio.label]) : null,
      modelUrl,
    ] as const,
  modelFile: (url: string) => ["modelFile", url] as const,
  blenderTools: ["blender-tools"] as const,
  studioMcpStatus: ["studio-mcp-status"] as const,
};
