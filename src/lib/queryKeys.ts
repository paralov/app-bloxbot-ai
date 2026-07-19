export const qk = {
  sessions: ["sessions"] as const,
  session: (id: string) => ["sessions", id] as const,
  messages: (id: string) => ["sessions", id, "messages"] as const,
  todos: (id: string) => ["sessions", id, "todos"] as const,
  statuses: ["session-statuses"] as const,
  providers: ["providers"] as const,
  agents: ["agents"] as const,
  questions: ["questions"] as const,
  permissions: ["permissions"] as const,
  config: ["config"] as const,
  studioConnection: ["studio-connection"] as const,
};
