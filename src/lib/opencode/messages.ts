import type {
  FormField,
  FormInfo,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionStructuredError,
} from "@opencode/client";

import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  QuestionRequest,
  Session,
  Todo,
  ToolPart,
} from "./types";

export type ModelError = NonNullable<AssistantMessage["error"]>;

export interface MessageWithParts {
  info: Message;
  parts: Part[];
}

// OpenCode 2 renamed these tools. The UI and analytics keep the established names.
const TOOL_NAMES: Record<string, string> = { shell: "bash", subagent: "task" };

export function toolName(name: string): string {
  return TOOL_NAMES[name] ?? name;
}

/** OpenCode 2 file tools take `path`; the tool views read `filePath`. */
function toolInput(input: Record<string, unknown>): Record<string, unknown> {
  return typeof input.path === "string" && input.filePath === undefined
    ? { ...input, filePath: input.path }
    : input;
}

export function toSession(info: SessionInfo): Session {
  return {
    id: info.id,
    slug: "",
    projectID: info.projectID,
    directory: info.location.directory,
    parentID: info.parentID,
    title: info.title ?? "",
    version: "",
    metadata: info.metadata,
    time: { created: info.time.created, updated: info.time.updated, archived: info.time.archived },
  } as Session;
}

const ERROR_NAMES: ReadonlyArray<readonly [RegExp, ModelError["name"]]> = [
  [/abort|interrupt/i, "MessageAbortedError"],
  [/auth|credential|unauthorized/i, "ProviderAuthError"],
  [/context.?(overflow|window|length)|too.?large/i, "ContextOverflowError"],
  [/structured/i, "StructuredOutputError"],
];

export function toModelError(error: SessionStructuredError): ModelError {
  const name =
    ERROR_NAMES.find(([pattern]) => pattern.test(error.type))?.[1] ??
    (error.status !== undefined ? "APIError" : "UnknownError");
  return {
    name,
    data: {
      message: error.message,
      statusCode: error.status,
      responseBody: error.response?.body,
      retryAfterMs: error.retryAfterMs,
      isRetryable: false,
    },
  } as ModelError;
}

export function textPartId(messageID: string, kind: "text" | "reasoning", ordinal: number): string {
  return `${messageID}:${kind}:${ordinal}`;
}

export function toToolPart(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): ToolPart {
  const { state, time } = tool;
  const base = {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: toolName(tool.name),
  };
  if (state.status === "streaming") {
    return { ...base, state: { status: "pending", input: {}, raw: state.input } };
  }
  const input = toolInput(state.input);
  if (state.status === "running") {
    return {
      ...base,
      state: {
        status: "running",
        input,
        metadata: state.metadata,
        time: { start: time.ran ?? time.created },
      },
    };
  }
  const span = { start: time.ran ?? time.created, end: time.completed ?? time.created };
  if (state.status === "error") {
    return {
      ...base,
      state: {
        status: "error",
        input,
        error: state.error.message,
        metadata: state.metadata,
        time: span,
      },
    };
  }
  return {
    ...base,
    state: {
      status: "completed",
      input,
      ...toolResult(sessionID, messageID, tool.id, state.content),
      title: "",
      metadata: state.metadata ?? {},
      time: span,
    },
  };
}

type ToolContent = Extract<
  SessionMessageAssistantTool["state"],
  { status: "completed" }
>["content"][number];

export function toolResult(
  sessionID: string,
  messageID: string,
  callID: string,
  content: ReadonlyArray<ToolContent>,
): { output: string; attachments?: FilePart[] } {
  const output = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  const attachments = content.flatMap((item, index): FilePart[] =>
    item.type === "text"
      ? []
      : [
          {
            id: `${callID}:file:${index}`,
            sessionID,
            messageID,
            type: "file",
            mime: item.mime,
            filename: item.name ?? undefined,
            url: item.uri,
          },
        ],
  );
  return attachments.length > 0 ? { output, attachments } : { output };
}

export function assistantInfo(
  sessionID: string,
  message: Pick<SessionMessageAssistant, "id" | "time" | "agent" | "model"> &
    Partial<SessionMessageAssistant>,
  parentID: string,
): AssistantMessage {
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: { created: message.time.created, completed: message.time.completed },
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    mode: message.agent,
    agent: message.agent,
    variant: message.model.variant,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    finish: message.finish,
    error: message.error ? toModelError(message.error) : undefined,
  } as AssistantMessage;
}

/** One message from OpenCode 2's history, or null for bookkeeping entries the chat doesn't show. */
export function toMessageWithParts(
  sessionID: string,
  message: SessionMessageInfo,
  parentID: string,
): MessageWithParts | null {
  const shared = { sessionID, messageID: message.id };
  if (message.type === "user") {
    const parts: Part[] = [];
    if (message.text) {
      parts.push({ ...shared, id: `${message.id}:text`, type: "text", text: message.text });
    }
    for (const [index, file] of (message.files ?? []).entries()) {
      parts.push({
        ...shared,
        id: `${message.id}:file:${index}`,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: `data:${file.mime};base64,${file.data}`,
      });
    }
    return { info: userInfo(sessionID, message.id, message.time.created), parts };
  }
  if (message.type === "compaction") {
    return {
      info: userInfo(sessionID, message.id, message.time.created),
      parts: [{ ...shared, id: `${message.id}:compaction`, type: "compaction", auto: true }],
    };
  }
  if (message.type !== "assistant") return null;

  const ordinals = { text: 0, reasoning: 0 };
  const parts = message.content.map((item): Part => {
    if (item.type === "tool") return toToolPart(sessionID, message.id, item);
    const id = textPartId(message.id, item.type, ordinals[item.type]++);
    return item.type === "text"
      ? {
          ...shared,
          id,
          type: "text",
          text: item.text,
          time: { start: message.time.created, end: message.time.completed },
        }
      : {
          ...shared,
          id,
          type: "reasoning",
          text: item.text,
          time: { start: message.time.created, end: message.time.completed },
        };
  });
  return { info: assistantInfo(sessionID, message, parentID), parts };
}

export function userInfo(sessionID: string, id: string, created: number): Message {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "",
    model: { providerID: "", modelID: "" },
  };
}

export function historyToMessages(
  sessionID: string,
  history: ReadonlyArray<SessionMessageInfo>,
): MessageWithParts[] {
  const messages: MessageWithParts[] = [];
  let parentID = "";
  for (const entry of history) {
    if (entry.type === "user") parentID = entry.id;
    const message = toMessageWithParts(sessionID, entry, parentID);
    if (message) messages.push(message);
  }
  return messages;
}

/** The todos a `todowrite` call settled on, which OpenCode 2 only records in the tool result. */
export function todosFromToolMetadata(metadata: unknown): Todo[] | null {
  const todos = (metadata as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  return (todos as Array<Partial<Todo>>).map((todo) => ({
    content: todo.content ?? "",
    status: todo.status ?? "pending",
    priority: todo.priority ?? "medium",
  }));
}

export function todosFromHistory(history: ReadonlyArray<SessionMessageInfo>): Todo[] {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type !== "assistant") continue;
    for (let toolIndex = entry.content.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const item = entry.content[toolIndex];
      if (item?.type !== "tool" || item.name !== "todowrite") continue;
      const todos = "metadata" in item.state ? todosFromToolMetadata(item.state.metadata) : null;
      if (todos) return todos;
    }
  }
  return [];
}

/** OpenCode 2 asks questions as forms: each visible field is one question. */
const isVisibleField = (field: FormField) => !("hidden" in field && field.hidden);

export function toQuestionRequest(form: FormInfo): QuestionRequest {
  const tool = form.metadata?.tool as { messageID?: string; id?: string } | undefined;
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.filter(isVisibleField).map((field) => ({
      header: field.title ?? form.title,
      question: field.description ?? field.title ?? form.title,
      options:
        "options" in field
          ? (field.options ?? []).map((option) => ({
              label: option.label,
              description: option.description ?? "",
            }))
          : [],
      multiple: field.type === "multiselect",
      custom: "custom" in field ? field.custom : true,
    })),
    tool: tool?.messageID && tool.id ? { messageID: tool.messageID, callID: tool.id } : undefined,
  };
}

/** Puts one answer per question back under the form's field keys, using values it offered. */
export function toFormAnswer(
  form: FormInfo,
  answers: ReadonlyArray<ReadonlyArray<string>>,
): Record<string, string | ReadonlyArray<string>> {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  const fields = form.fields.filter(isVisibleField);
  for (const [index, field] of fields.entries()) {
    const options = "options" in field ? (field.options ?? []) : [];
    const values = (answers[index] ?? []).map(
      (label) => options.find((option) => option.label === label)?.value ?? label,
    );
    if (field.type === "multiselect") answer[field.key] = values;
    else if (values[0] !== undefined) answer[field.key] = values[0];
  }
  return answer;
}
