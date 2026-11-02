/**
 * The chat, provider and event model BloxBot's UI and analytics are written against. OpenCode 2's
 * API has different shapes, and `client.ts` and `events.ts` translate at that boundary, so this file
 * is the one contract the rest of the app depends on.
 */

export type SnapshotFileDiff = {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

export type PermissionAction = "allow" | "deny" | "ask";

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: PermissionAction;
};

export type PermissionRuleset = Array<PermissionRule>;

export type Session = {
  id: string;
  slug: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  path?: string;
  parentID?: string;
  summary?: {
    additions: number;
    deletions: number;
    files: number;
    diffs?: Array<SnapshotFileDiff>;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  share?: {
    url: string;
  };
  title: string;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  version: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    created: number;
    updated: number;
    compacting?: number;
    archived?: number;
  };
  permission?: PermissionRuleset;
  revert?: {
    messageID: string;
    partID?: string;
    snapshot?: string;
    diff?: string;
  };
};

export type OutputFormatText = {
  type: "text";
};

export type JsonSchema = {
  [key: string]: unknown;
};

export type OutputFormatJsonSchema = {
  type: "json_schema";
  schema: JsonSchema;
  retryCount?: number;
};

export type OutputFormat = OutputFormatText | OutputFormatJsonSchema;

export type UserMessage = {
  id: string;
  sessionID: string;
  role: "user";
  time: {
    created: number;
  };
  format?: OutputFormat;
  summary?: {
    title?: string;
    body?: string;
    diffs: Array<SnapshotFileDiff>;
  };
  agent: string;
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
  system?: string;
  tools?: {
    [key: string]: boolean;
  };
};

export type ProviderAuthError = {
  name: "ProviderAuthError";
  data: {
    providerID: string;
    message: string;
  };
};

export type UnknownError = {
  name: "UnknownError";
  data: {
    message: string;
    ref?: string;
  };
};

export type MessageOutputLengthError = {
  name: "MessageOutputLengthError";
  data: {
    [key: string]: unknown;
  };
};

export type MessageAbortedError = {
  name: "MessageAbortedError";
  data: {
    message: string;
  };
};

export type StructuredOutputError = {
  name: "StructuredOutputError";
  data: {
    message: string;
    retries: number;
  };
};

export type ContextOverflowError = {
  name: "ContextOverflowError";
  data: {
    message: string;
    responseBody?: string;
  };
};

export type ContentFilterError = {
  name: "ContentFilterError";
  data: {
    message: string;
  };
};

export type ApiError = {
  name: "APIError";
  data: {
    message: string;
    statusCode?: number;
    isRetryable: boolean;
    responseHeaders?: {
      [key: string]: string;
    };
    responseBody?: string;
    metadata?: {
      [key: string]: string;
    };
  };
};

export type AssistantMessage = {
  id: string;
  sessionID: string;
  role: "assistant";
  time: {
    created: number;
    completed?: number;
  };
  error?:
    | ProviderAuthError
    | UnknownError
    | MessageOutputLengthError
    | MessageAbortedError
    | StructuredOutputError
    | ContextOverflowError
    | ContentFilterError
    | ApiError;
  parentID: string;
  modelID: string;
  providerID: string;
  mode: string;
  agent: string;
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  structured?: unknown;
  variant?: string;
  finish?: string;
};

export type Message = UserMessage | AssistantMessage;

export type TextPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: {
    start: number;
    end?: number;
  };
  metadata?: {
    [key: string]: unknown;
  };
};

export type SubtaskPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerID: string;
    modelID: string;
  };
  command?: string;
};

export type ReasoningPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "reasoning";
  text: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end?: number;
  };
};

export type FilePartSourceText = {
  value: string;
  start: number;
  end: number;
};

export type FileSource = {
  text: FilePartSourceText;
  type: "file";
  path: string;
};

export type Range = {
  start: {
    line: number;
    character: number;
  };
  end: {
    line: number;
    character: number;
  };
};

export type SymbolSource = {
  text: FilePartSourceText;
  type: "symbol";
  path: string;
  range: Range;
  name: string;
  kind: number;
};

export type ResourceSource = {
  text: FilePartSourceText;
  type: "resource";
  clientName: string;
  uri: string;
};

export type FilePartSource = FileSource | SymbolSource | ResourceSource;

export type FilePart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};

export type ToolStatePending = {
  status: "pending";
  input: {
    [key: string]: unknown;
  };
  raw: string;
};

export type ToolStateRunning = {
  status: "running";
  input: {
    [key: string]: unknown;
  };
  title?: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
  };
};

export type ToolStateCompleted = {
  status: "completed";
  input: {
    [key: string]: unknown;
  };
  output: string;
  title: string;
  metadata: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: Array<FilePart>;
};

export type ToolStateError = {
  status: "error";
  input: {
    [key: string]: unknown;
  };
  error: string;
  metadata?: {
    [key: string]: unknown;
  };
  time: {
    start: number;
    end: number;
  };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export type ToolPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "tool";
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: {
    [key: string]: unknown;
  };
};

export type StepStartPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-start";
  snapshot?: string;
};

export type StepFinishPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: {
    total?: number;
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
};

export type SnapshotPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "snapshot";
  snapshot: string;
};

export type PatchPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "patch";
  hash: string;
  files: Array<string>;
};

export type AgentPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "agent";
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

export type RetryPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "retry";
  attempt: number;
  error: ApiError;
  time: {
    created: number;
  };
};

export type CompactionPart = {
  id: string;
  sessionID: string;
  messageID: string;
  type: "compaction";
  auto: boolean;
  overflow?: boolean;
  tail_start_id?: string;
};

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart;

export type Todo = {
  /**
   * Brief description of the task
   */
  content: string;
  /**
   * Current status of the task: pending, in_progress, completed, cancelled
   */
  status: string;
  /**
   * Priority level of the task: high, medium, low
   */
  priority: string;
};

export type SessionStatus =
  | {
      type: "idle";
    }
  | {
      type: "retry";
      attempt: number;
      message: string;
      action?: {
        reason: string;
        provider: string;
        title: string;
        message: string;
        label: string;
        link?: string;
      };
      next: number;
    }
  | {
      type: "busy";
    };

export type QuestionOption = {
  /**
   * Display text (1-5 words, concise)
   */
  label: string;
  /**
   * Explanation of choice
   */
  description: string;
};

export type QuestionInfo = {
  /**
   * Complete question
   */
  question: string;
  /**
   * Very short label (max 30 chars)
   */
  header: string;
  /**
   * Available choices
   */
  options: Array<QuestionOption>;
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionTool = {
  messageID: string;
  callID: string;
};

export type QuestionAnswer = Array<string>;

export type Model = {
  id: string;
  providerID: string;
  api: {
    id: string;
    url: string;
    npm: string;
  };
  name: string;
  family?: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    output: {
      text: boolean;
      audio: boolean;
      image: boolean;
      video: boolean;
      pdf: boolean;
    };
    interleaved:
      | boolean
      | {
          field: "reasoning" | "reasoning_content" | "reasoning_details";
        };
  };
  cost: {
    input: number;
    output: number;
    cache: {
      read: number;
      write: number;
    };
    tiers?: Array<{
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
      tier: {
        type: "context";
        size: number;
      };
    }>;
    experimentalOver200K?: {
      input: number;
      output: number;
      cache: {
        read: number;
        write: number;
      };
    };
  };
  limit: {
    context: number;
    input?: number;
    output: number;
  };
  status: "alpha" | "beta" | "deprecated" | "active";
  options: {
    [key: string]: unknown;
  };
  headers: {
    [key: string]: string;
  };
  release_date: string;
  variants?: {
    [key: string]: {
      [key: string]: unknown;
    };
  };
};

export type Provider = {
  id: string;
  name: string;
  source: "env" | "config" | "custom" | "api";
  env: Array<string>;
  key?: string;
  options: {
    [key: string]: unknown;
  };
  models: {
    [key: string]: Model;
  };
};

export type Command = {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: "command" | "mcp" | "skill";
  template: string;
  subtask?: boolean;
  hints: Array<string>;
};

export type McpStatusConnected = {
  status: "connected";
};

export type McpStatusDisabled = {
  status: "disabled";
};

export type McpStatusFailed = {
  status: "failed";
  error: string;
};

export type McpStatusNeedsAuth = {
  status: "needs_auth";
};

export type McpStatusNeedsClientRegistration = {
  status: "needs_client_registration";
  error: string;
};

export type McpStatus =
  | McpStatusConnected
  | McpStatusDisabled
  | McpStatusFailed
  | McpStatusNeedsAuth
  | McpStatusNeedsClientRegistration;

export type QuestionRequest = {
  id: string;
  sessionID: string;
  /**
   * Questions to ask
   */
  questions: Array<QuestionInfo>;
  tool?: QuestionTool;
};

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: Array<string>;
  metadata: {
    [key: string]: unknown;
  };
  always: Array<string>;
  tool?: {
    messageID: string;
    callID: string;
  };
};

export type ProviderAuthMethod = {
  type: "oauth" | "api";
  label: string;
  prompts?: Array<
    | {
        type: "text";
        key: string;
        message: string;
        placeholder?: string;
        when?: {
          key: string;
          op: "eq" | "neq";
          value: string;
        };
      }
    | {
        type: "select";
        key: string;
        message: string;
        options: Array<{
          label: string;
          value: string;
          hint?: string;
        }>;
        when?: {
          key: string;
          op: "eq" | "neq";
          value: string;
        };
      }
  >;
};

export type EventSessionCreated = {
  type: "session.created";
  properties: {
    sessionID: string;
    info: Session;
  };
};

export type EventSessionUpdated = {
  type: "session.updated";
  properties: {
    sessionID: string;
    info: Session;
  };
};

export type EventSessionDeleted = {
  type: "session.deleted";
  properties: {
    sessionID: string;
    info: Session;
  };
};

export type EventMessageUpdated = {
  type: "message.updated";
  properties: {
    sessionID: string;
    info: Message;
  };
};

export type EventMessageRemoved = {
  type: "message.removed";
  properties: {
    sessionID: string;
    messageID: string;
  };
};

export type EventMessagePartUpdated = {
  type: "message.part.updated";
  properties: {
    sessionID: string;
    part: Part;
    time: number;
  };
};

export type EventMessagePartRemoved = {
  type: "message.part.removed";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
  };
};

export type EventMessagePartDelta = {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: string;
  };
};

export type EventSessionDiff = {
  type: "session.diff";
  properties: {
    sessionID: string;
    diff: Array<SnapshotFileDiff>;
  };
};

export type EventSessionError = {
  type: "session.error";
  properties: {
    sessionID?: string;
    error?:
      | ProviderAuthError
      | UnknownError
      | MessageOutputLengthError
      | MessageAbortedError
      | StructuredOutputError
      | ContextOverflowError
      | ContentFilterError
      | ApiError;
  };
};

export type EventTodoUpdated = {
  type: "todo.updated";
  properties: {
    sessionID: string;
    todos: Array<Todo>;
  };
};

export type EventPermissionAsked = {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: Array<string>;
    metadata: {
      [key: string]: unknown;
    };
    always: Array<string>;
    tool?: {
      messageID: string;
      callID: string;
    };
  };
};

export type EventPermissionReplied = {
  type: "permission.replied";
  properties: {
    sessionID: string;
    requestID: string;
    reply: "once" | "always" | "reject";
  };
};

export type EventSessionStatus = {
  type: "session.status";
  properties: {
    sessionID: string;
    status: SessionStatus;
  };
};

export type EventSessionIdle = {
  type: "session.idle";
  properties: {
    sessionID: string;
  };
};

export type EventQuestionAsked = {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    /**
     * Questions to ask
     */
    questions: Array<QuestionInfo>;
    tool?: QuestionTool;
  };
};

export type EventQuestionReplied = {
  type: "question.replied";
  properties: {
    sessionID: string;
    requestID: string;
    answers: Array<QuestionAnswer>;
  };
};

export type EventQuestionRejected = {
  type: "question.rejected";
  properties: {
    sessionID: string;
    requestID: string;
  };
};

export type EventSessionCompacted = {
  type: "session.compacted";
  properties: {
    sessionID: string;
  };
};

export type ProviderListResponses = {
  /**
   * List of providers
   */
  200: {
    all: Array<Provider>;
    default: {
      [key: string]: string;
    };
    connected: Array<string>;
  };
};

export type ProviderListResponse = ProviderListResponses[keyof ProviderListResponses];

export type ProviderAuthResponses = {
  /**
   * Provider auth methods
   */
  200: {
    [key: string]: Array<ProviderAuthMethod>;
  };
};

export type ProviderAuthResponse = ProviderAuthResponses[keyof ProviderAuthResponses];

export type Event =
  | EventSessionCreated
  | EventSessionUpdated
  | EventSessionDeleted
  | EventSessionStatus
  | EventSessionCompacted
  | EventSessionError
  | EventSessionIdle
  | EventMessageUpdated
  | EventMessageRemoved
  | EventMessagePartUpdated
  | EventMessagePartDelta
  | EventMessagePartRemoved
  | EventTodoUpdated
  | EventQuestionAsked
  | EventQuestionReplied
  | EventQuestionRejected
  | EventPermissionAsked
  | EventPermissionReplied
  | EventSessionDiff;
