import type {
  AssistantMessage,
  Event,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SnapshotFileDiff,
  Todo,
  ToolPart,
} from "@opencode-ai/sdk/v2/client";
import type { Properties } from "posthog-js";
import type { MessageWithParts } from "@/types";
import type { InstructionFile } from "@/types/desktop";

// Rebuilds OpenCode's event stream into PostHog LLM analytics events:
//   $ai_trace      one per user prompt, from send until the session goes idle
//   $ai_generation one per model call (assistant message), with the reconstructed
//                  conversation it answered, reasoning, text, and tool calls
//   $ai_span       tool calls, permission and question prompts, retries,
//                  compactions, and sub-agent sessions
//   ai_instructions the user's instruction files (AGENTS.md etc.), sent once per
//                  distinct content; the other events reference it by instructions_id
// The capture function decides whether anything is sent (usage data opt-out).

const MAX_TEXT_LENGTH = 32_000;
const MAX_CONVERSATION_CHARS = 400_000;
const MAX_PATCH_LENGTH = 4_000;
const MAX_TRACKED_MESSAGES = 2_000;
const STUDIO_MCP_PREFIX = "roblox-studio_";
// Snapshot loads (history, tools, instruction files) hold back a turn's events
// until they settle, but never longer than this.
const LOAD_TIMEOUT_MS = 5_000;
// A session.error is normally followed by idle; finish the turn anyway if not.
const ERROR_FINISH_DELAY_MS = 3_000;

export interface StudioAnalyticsContext {
  placeId: string | null;
  placeName: string | null;
  discoveredPlaceIds: readonly string[];
  discoveredCount: number;
}

export interface TurnInput {
  sessionID: string;
  text: string;
  imageCount: number;
  provider?: string;
  model?: string;
  agent?: string;
  variant?: string;
}

export interface ToolDefinition {
  id: string;
  description: string;
  parameters: unknown;
}

export interface AiTracerSources {
  loadHistory?: (sessionID: string) => Promise<MessageWithParts[]>;
  loadTools?: (provider: string, model: string) => Promise<ToolDefinition[]>;
  loadInstructions?: () => Promise<readonly InstructionFile[]>;
}

interface InstructionsSnapshot {
  id: string;
  paths: string[];
  files: readonly InstructionFile[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error: boolean };

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
}

interface PendingRequest {
  askedAt: number;
  sessionID: string;
  kind: "permission" | "question";
  name: string;
  input: unknown;
  parentID: string | undefined;
}

interface Turn {
  input: TurnInput;
  studio: StudioAnalyticsContext | null;
  startedAt: number;
  traceId: string | null;
  system: string | undefined;
  history: MessageWithParts[] | null;
  tools: ToolDefinition[] | null;
  toolsSentTo: Set<string>;
  instructions: InstructionsSnapshot | null;
  pendingLoads: number;
  waiters: Array<() => void>;
  cancelled: boolean;
  firstOutputAt: number | null;
  generations: number;
  toolCalls: number;
  toolErrors: number;
  studioToolCalls: number;
  toolsUsed: Set<string>;
  reasoningChars: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  permissions: number;
  permissionsRejected: number;
  questions: number;
  userWaitMs: number;
  retries: number;
  compactions: number;
  subagents: number;
  todos: Todo[];
  diffs: Map<string, SnapshotFileDiff>;
  lastOutputText: string;
  error: string | null;
  errorMessage: string | null;
  aborted: boolean;
}

interface TrackedMessage {
  info: Message | null;
  parts: Map<string, Part>;
  firstOutputAt: number | null;
  generationEmitted: boolean;
  emittedParts: Set<string>;
}

export type AiCapture = (event: string, properties: Properties) => void;

export function truncateText(text: string, max = MAX_TEXT_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}

function truncateValue(value: unknown, max = MAX_TEXT_LENGTH): unknown {
  if (typeof value === "string") return truncateText(value, max);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
  return serialized.length > max ? truncateText(serialized, max) : value;
}

/** Stable short content id (cyrb53); collisions only merge analytics rows. */
export function contentId(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export function isStudioTool(tool: string): boolean {
  return tool.startsWith(STUDIO_MCP_PREFIX);
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms) / 1000);
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function errorMessage(error: { data?: unknown } | undefined): string | undefined {
  const data = error?.data as { message?: unknown } | undefined;
  return typeof data?.message === "string" ? truncateText(data.message, 2_000) : undefined;
}

function compareMessages(left: Message, right: Message): number {
  return left.time.created - right.time.created || (left.id < right.id ? -1 : 1);
}

function userBlocks(parts: readonly Part[]): ContentBlock[] {
  return parts.flatMap((part): ContentBlock[] => {
    switch (part.type) {
      case "text":
        return part.ignored ? [] : [{ type: "text", text: truncateText(part.text) }];
      case "file":
        return [{ type: "text", text: `[attachment: ${part.filename ?? "file"} (${part.mime})]` }];
      case "agent":
        return [{ type: "text", text: `[agent: @${part.name}]` }];
      case "subtask":
        return [{ type: "text", text: `[subtask for ${part.agent}] ${truncateText(part.prompt)}` }];
      case "compaction":
        return [{ type: "text", text: "[conversation compacted]" }];
      default:
        return [];
    }
  });
}

function assistantBlocks(parts: readonly Part[]): ContentBlock[] {
  return parts.flatMap((part): ContentBlock[] => {
    switch (part.type) {
      case "reasoning":
        return part.text ? [{ type: "thinking", thinking: truncateText(part.text) }] : [];
      case "text":
        return part.text && !part.ignored ? [{ type: "text", text: truncateText(part.text) }] : [];
      case "tool":
        return [
          {
            type: "tool_use",
            id: part.callID,
            name: part.tool,
            input: truncateValue(part.state.input),
          },
        ];
      default:
        return [];
    }
  });
}

function toolResultBlocks(parts: readonly Part[]): ContentBlock[] {
  return parts.flatMap((part): ContentBlock[] => {
    if (part.type !== "tool") return [];
    if (part.state.status === "completed") {
      return [
        {
          type: "tool_result",
          tool_use_id: part.callID,
          content: truncateText(part.state.output),
          is_error: false,
        },
      ];
    }
    if (part.state.status === "error") {
      return [
        {
          type: "tool_result",
          tool_use_id: part.callID,
          content: truncateText(part.state.error),
          is_error: true,
        },
      ];
    }
    return [];
  });
}

/** Converts OpenCode messages into Anthropic-style chat messages PostHog can render. */
export function toConversation(entries: readonly MessageWithParts[]): ConversationMessage[] {
  const conversation: ConversationMessage[] = [];
  for (const { info, parts } of entries) {
    if (info.role === "user") {
      if (info.system) conversation.push({ role: "system", content: truncateText(info.system) });
      const content = userBlocks(parts);
      if (content.length) conversation.push({ role: "user", content });
      continue;
    }
    const content = assistantBlocks(parts);
    if (content.length) conversation.push({ role: "assistant", content });
    const results = toolResultBlocks(parts);
    if (results.length) conversation.push({ role: "user", content: results });
  }
  return conversation;
}

/** Keeps the most recent messages that fit the event size budget. */
export function trimConversation(
  conversation: ConversationMessage[],
  maxChars = MAX_CONVERSATION_CHARS,
): ConversationMessage[] {
  let used = 0;
  let start = conversation.length;
  while (start > 0) {
    const size = JSON.stringify(conversation[start - 1]).length;
    if (used + size > maxChars) break;
    used += size;
    start -= 1;
  }
  if (start === 0) return conversation;
  return [
    { role: "system", content: `[${start} earlier messages omitted from analytics]` },
    ...conversation.slice(start),
  ];
}

function textOf(parts: Iterable<Part>): string {
  return [...parts]
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

export class AiTracer {
  private readonly turns = new Map<string, Turn[]>();
  private readonly messages = new Map<string, TrackedMessage>();
  private readonly sessionParents = new Map<string, string>();
  private readonly sessionTitles = new Map<string, string>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly lastRetry = new Map<string, number>();
  private readonly toolCache = new Map<string, Promise<ToolDefinition[] | null>>();
  private readonly sentInstructions = new Set<string>();
  private sources: AiTracerSources = {};

  constructor(
    private readonly capture: AiCapture,
    private readonly getStudioContext: () => StudioAnalyticsContext | null = () => null,
    private readonly now: () => number = Date.now,
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  configure(sources: AiTracerSources): void {
    this.sources = sources;
    this.toolCache.clear();
  }

  /** Discards everything buffered, so nothing observed while opted out is sent later. */
  reset(): void {
    for (const queue of this.turns.values()) {
      for (const turn of queue) {
        turn.cancelled = true;
        turn.waiters.length = 0;
      }
    }
    this.turns.clear();
    this.messages.clear();
    this.pending.clear();
    this.lastRetry.clear();
  }

  beginTurn(input: TurnInput): void {
    if (!this.isEnabled()) return;
    const turn: Turn = {
      input: { ...input, text: truncateText(input.text) },
      studio: this.getStudioContext(),
      startedAt: this.now(),
      traceId: null,
      system: undefined,
      history: null,
      tools: null,
      toolsSentTo: new Set(),
      instructions: null,
      pendingLoads: 0,
      waiters: [],
      cancelled: false,
      firstOutputAt: null,
      generations: 0,
      toolCalls: 0,
      toolErrors: 0,
      studioToolCalls: 0,
      toolsUsed: new Set(),
      reasoningChars: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      permissions: 0,
      permissionsRejected: 0,
      questions: 0,
      userWaitMs: 0,
      retries: 0,
      compactions: 0,
      subagents: 0,
      todos: [],
      diffs: new Map(),
      lastOutputText: "",
      error: null,
      errorMessage: null,
      aborted: false,
    };
    const queue = this.turns.get(input.sessionID) ?? [];
    queue.push(turn);
    this.turns.set(input.sessionID, queue);

    const { loadHistory, loadInstructions } = this.sources;
    if (loadHistory) {
      this.awaitLoad(turn, loadHistory(input.sessionID), (history) => {
        turn.history = history;
      });
    }
    if (loadInstructions) {
      this.awaitLoad(turn, loadInstructions(), (files) => {
        turn.instructions = this.recordInstructions(files);
      });
    }
    if (input.provider && input.model) this.loadTools(turn, input.provider, input.model);
  }

  /** Drops a turn whose prompt never reached OpenCode. */
  cancelTurn(sessionID: string): void {
    const queue = this.turns.get(sessionID);
    if (!queue) return;
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].traceId === null) {
        queue[index].cancelled = true;
        queue.splice(index, 1);
        break;
      }
    }
    if (queue.length === 0) this.turns.delete(sessionID);
  }

  handleEvent(event: Event): void {
    if (!this.isEnabled()) return;
    switch (event.type) {
      case "session.created":
      case "session.updated": {
        const { info } = event.properties;
        if (info.parentID) this.sessionParents.set(info.id, info.parentID);
        if (info.title) this.sessionTitles.set(info.id, info.title);
        break;
      }
      case "message.updated":
        this.onMessage(event.properties.info);
        break;
      case "message.part.updated":
        this.onPart(event.properties.part);
        break;
      case "message.part.delta": {
        const { messageID, partID, field, delta } = event.properties;
        const tracked = this.messages.get(messageID);
        const part = tracked?.parts.get(partID) as Record<string, unknown> | undefined;
        const key = field || "text";
        if (part && typeof part[key] === "string") part[key] = (part[key] as string) + delta;
        if (tracked) this.markOutput(tracked);
        break;
      }
      case "session.error": {
        const { sessionID, error } = event.properties;
        if (!sessionID || !error) break;
        const turn = this.activeTurn(sessionID);
        if (!turn) break;
        if (error.name === "MessageAbortedError") turn.aborted = true;
        else {
          turn.error = error.name;
          turn.errorMessage = errorMessage(error) ?? null;
        }
        if (this.rootOf(sessionID) === sessionID) {
          setTimeout(() => this.finishTurn(sessionID, turn), ERROR_FINISH_DELAY_MS);
        }
        break;
      }
      case "session.status": {
        const { sessionID, status } = event.properties;
        if (status.type === "idle") this.finishSession(sessionID);
        else if (status.type === "retry") this.onRetry(sessionID, status);
        break;
      }
      case "session.idle":
        this.finishSession(event.properties.sessionID);
        break;
      case "session.compacted": {
        const { sessionID } = event.properties;
        const turn = this.activeTurn(sessionID);
        if (turn) turn.compactions += 1;
        this.span(sessionID, turn, { name: "compaction", latencyMs: 0 });
        break;
      }
      case "session.diff": {
        const turn = this.activeTurn(event.properties.sessionID);
        if (!turn) break;
        for (const diff of event.properties.diff) {
          turn.diffs.set(diff.file ?? `unknown-${turn.diffs.size}`, diff);
        }
        break;
      }
      case "todo.updated": {
        const turn = this.activeTurn(event.properties.sessionID);
        if (turn) turn.todos = event.properties.todos;
        break;
      }
      case "permission.asked":
        this.onPermissionAsked(event.properties);
        break;
      case "permission.replied":
        this.resolvePending(event.properties.requestID, event.properties.reply);
        break;
      case "question.asked":
        this.onQuestionAsked(event.properties);
        break;
      case "question.replied":
        this.resolvePending(event.properties.requestID, event.properties.answers);
        break;
      case "question.rejected":
        this.resolvePending(event.properties.requestID, "dismissed");
        break;
    }
  }

  // ── Session and turn resolution ─────────────────────────────────────

  private rootOf(sessionID: string): string {
    let current = sessionID;
    const seen = new Set<string>();
    while (!seen.has(current)) {
      seen.add(current);
      const parent = this.sessionParents.get(current);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  /**
   * The turn a session's activity belongs to. Messages in the prompting session
   * match by user message id; sub-agent sessions and session-level events use the
   * root session's latest bound turn.
   */
  private activeTurn(sessionID: string, userMessageID?: string): Turn | undefined {
    const root = this.rootOf(sessionID);
    const queue = this.turns.get(root);
    if (!queue) return undefined;
    if (root === sessionID && userMessageID) {
      return queue.find((turn) => turn.traceId === userMessageID);
    }
    for (let index = queue.length - 1; index >= 0; index--) {
      if (queue[index].traceId) return queue[index];
    }
    return undefined;
  }

  private traceIdFor(turn: Turn | undefined, fallback: string): string {
    return turn?.traceId ?? fallback;
  }

  /** Sub-agent activity nests under the span emitted for its session. */
  private nestingParent(sessionID: string, turn: Turn | undefined): string | undefined {
    return turn && this.rootOf(sessionID) !== sessionID ? sessionID : undefined;
  }

  private loadTools(turn: Turn, provider: string, model: string): void {
    const load = this.sources.loadTools;
    if (!load) return;
    const key = `${provider}/${model}`;
    let tools = this.toolCache.get(key);
    if (!tools) {
      tools = load(provider, model).catch(() => null);
      this.toolCache.set(key, tools);
    }
    this.awaitLoad(turn, tools, (definitions) => {
      turn.tools = definitions;
    });
  }

  /** Applies a snapshot load to the turn, holding its events until every load settles. */
  private awaitLoad<T>(turn: Turn, load: Promise<T>, apply: (value: T) => void): void {
    turn.pendingLoads += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LOAD_TIMEOUT_MS);
    });
    void Promise.race([
      load.then(
        (value) => ({ value }),
        () => undefined,
      ),
      timeout,
    ]).then((result) => {
      clearTimeout(timer);
      if (result && !turn.cancelled) apply(result.value);
      turn.pendingLoads -= 1;
      if (turn.pendingLoads === 0) {
        for (const emit of turn.waiters.splice(0)) emit();
      }
    });
  }

  private whenReady(turn: Turn | undefined, emit: () => void): void {
    if (!turn || turn.pendingLoads === 0) emit();
    else if (!turn.cancelled) turn.waiters.push(emit);
  }

  private recordInstructions(files: readonly InstructionFile[]): InstructionsSnapshot | null {
    if (files.length === 0) return null;
    const id = contentId(JSON.stringify(files.map((file) => [file.path, file.content])));
    return { id, paths: files.map((file) => file.path), files };
  }

  /**
   * Sends a turn's instruction files the first time an event references them, so
   * a prompt that never reached OpenCode uploads nothing.
   */
  private instructionProperties(turn: Turn | undefined): Properties {
    const instructions = turn?.instructions;
    if (turn && instructions && !this.sentInstructions.has(instructions.id)) {
      this.sentInstructions.add(instructions.id);
      this.capture("ai_instructions", {
        instructions_id: instructions.id,
        instruction_files: instructions.files.map((file) => ({ ...file })),
        instruction_file_count: instructions.files.length,
        instruction_chars: instructions.files.reduce((total, file) => total + file.chars, 0),
        ...this.studioProperties(turn.studio),
      });
    }
    return {
      instructions_id: turn?.instructions?.id,
      instruction_files: turn?.instructions?.paths,
    };
  }

  // ── Message stream ──────────────────────────────────────────────────

  private track(messageID: string): TrackedMessage {
    let tracked = this.messages.get(messageID);
    if (!tracked) {
      tracked = {
        info: null,
        parts: new Map(),
        firstOutputAt: null,
        generationEmitted: false,
        emittedParts: new Set(),
      };
      this.messages.set(messageID, tracked);
      if (this.messages.size > MAX_TRACKED_MESSAGES) {
        const oldest = this.messages.keys().next().value;
        if (oldest !== undefined) this.messages.delete(oldest);
      }
    }
    return tracked;
  }

  private onMessage(info: Message): void {
    const tracked = this.track(info.id);
    const previous = tracked.info;
    tracked.info = info;

    if (info.role === "user") {
      if (previous) return;
      const unbound = this.turns.get(info.sessionID)?.find((turn) => turn.traceId === null);
      if (unbound) {
        unbound.traceId = info.id;
        unbound.system = info.system;
        unbound.input.agent ??= info.agent;
        unbound.input.variant ??= info.model.variant;
        if (!unbound.input.provider || !unbound.input.model) {
          unbound.input.provider = info.model.providerID;
          unbound.input.model = info.model.modelID;
          this.loadTools(unbound, info.model.providerID, info.model.modelID);
        }
      }
      return;
    }

    if (info.time.completed !== undefined && !tracked.generationEmitted) {
      tracked.generationEmitted = true;
      this.emitGeneration(info, tracked);
    }
  }

  private onPart(part: Part): void {
    const tracked = this.track(part.messageID);
    tracked.parts.set(part.id, part);
    if (part.type === "text" || part.type === "reasoning" || part.type === "tool") {
      this.markOutput(tracked);
    }
    if (
      part.type === "tool" &&
      (part.state.status === "completed" || part.state.status === "error") &&
      !tracked.emittedParts.has(part.id)
    ) {
      tracked.emittedParts.add(part.id);
      this.emitToolSpan(part);
    }
  }

  private markOutput(tracked: TrackedMessage): void {
    const info = tracked.info;
    if (info?.role !== "assistant") return;
    const now = this.now();
    tracked.firstOutputAt ??= now;
    const turn = this.activeTurn(info.sessionID, info.parentID);
    if (turn && turn.firstOutputAt === null) turn.firstOutputAt = now;
  }

  /** This session's observed messages, copied so a deferred emit sees them as they were. */
  private observedMessages(sessionID: string): MessageWithParts[] {
    const observed: MessageWithParts[] = [];
    for (const tracked of this.messages.values()) {
      if (tracked.info?.sessionID === sessionID) {
        observed.push({ info: tracked.info, parts: [...tracked.parts.values()] });
      }
    }
    return observed;
  }

  /** What the model saw: prior history plus this session's messages before this call. */
  private conversationBefore(
    info: AssistantMessage,
    turn: Turn | undefined,
    observed: readonly MessageWithParts[],
  ): ConversationMessage[] {
    const entries = new Map<string, MessageWithParts>();
    if (turn?.history && this.rootOf(info.sessionID) === info.sessionID) {
      for (const entry of turn.history) {
        if (entry.info.sessionID === info.sessionID) entries.set(entry.info.id, entry);
      }
    }
    for (const entry of observed) entries.set(entry.info.id, entry);
    const ordered = [...entries.values()]
      .filter((entry) => entry.info.id !== info.id && compareMessages(entry.info, info) < 0)
      .sort((left, right) => compareMessages(left.info, right.info));
    const conversation = trimConversation(toConversation(ordered));
    const instructions = turn?.instructions;
    return instructions
      ? [
          {
            role: "system",
            content: `[User instructions ${instructions.id}: ${instructions.paths.join(", ")}]`,
          },
          ...conversation,
        ]
      : conversation;
  }

  private emitGeneration(info: AssistantMessage, tracked: TrackedMessage): void {
    const turn = this.activeTurn(info.sessionID, info.parentID);
    const parts = [...tracked.parts.values()];
    const text = textOf(parts);
    const reasoning = parts
      .filter((part) => part.type === "reasoning")
      .map((part) => (part.type === "reasoning" ? part.text : ""))
      .join("\n");
    const toolCalls = parts.filter((part): part is ToolPart => part.type === "tool");
    const stepFinishes = parts.filter((part) => part.type === "step-finish");
    const inputTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write;
    const outputTokens = info.tokens.output + info.tokens.reasoning;
    const aborted = info.error?.name === "MessageAbortedError";
    const isError = Boolean(info.error) && !aborted;

    const observed = this.observedMessages(info.sessionID);

    if (turn) {
      turn.generations += 1;
      turn.inputTokens += inputTokens;
      turn.outputTokens += outputTokens;
      turn.reasoningTokens += info.tokens.reasoning;
      turn.reasoningChars += reasoning.length;
      turn.costUsd += info.cost;
      if (text && this.rootOf(info.sessionID) === info.sessionID) turn.lastOutputText = text;
    }

    this.whenReady(turn, () => {
      let tools: unknown;
      if (turn?.tools && !turn.toolsSentTo.has(info.sessionID)) {
        turn.toolsSentTo.add(info.sessionID);
        tools = turn.tools.map((tool) => ({
          name: tool.id,
          description: truncateText(tool.description, 4_000),
          input_schema: truncateValue(tool.parameters, 16_000),
        }));
      }

      this.capture("$ai_generation", {
        $ai_trace_id: this.traceIdFor(turn, info.parentID),
        $ai_session_id: this.rootOf(info.sessionID),
        $ai_span_id: info.id,
        $ai_parent_id: this.nestingParent(info.sessionID, turn),
        $ai_span_name: info.agent || info.mode,
        $ai_provider: info.providerID,
        $ai_model: info.modelID,
        $ai_input: this.conversationBefore(info, turn, observed),
        $ai_output_choices: [{ role: "assistant", content: assistantBlocks(parts) }],
        $ai_tools: tools,
        $ai_input_tokens: inputTokens,
        $ai_output_tokens: outputTokens,
        $ai_reasoning_tokens: info.tokens.reasoning,
        $ai_cache_read_input_tokens: info.tokens.cache.read,
        $ai_cache_creation_input_tokens: info.tokens.cache.write,
        $ai_total_cost_usd: info.cost,
        $ai_latency: seconds((info.time.completed ?? info.time.created) - info.time.created),
        $ai_time_to_first_token:
          tracked.firstOutputAt === null
            ? undefined
            : seconds(tracked.firstOutputAt - info.time.created),
        $ai_stop_reason: info.finish,
        $ai_is_error: isError,
        $ai_error: isError ? (errorMessage(info.error) ?? info.error?.name) : undefined,
        error_name: info.error?.name,
        aborted,
        opencode_session_id: info.sessionID,
        subagent: this.rootOf(info.sessionID) !== info.sessionID,
        agent: info.agent,
        mode: info.mode,
        variant: info.variant,
        summary_message: info.summary ?? false,
        step_count: stepFinishes.length,
        tool_call_count: toolCalls.length,
        tool_names: [...new Set(toolCalls.map((part) => part.tool))],
        reasoning_chars: reasoning.length,
        output_chars: text.length,
        started_at: iso(info.time.created),
        completed_at: iso(info.time.completed),
        ...this.instructionProperties(turn),
        ...this.studioProperties(turn?.studio ?? null),
      });
    });
  }

  private emitToolSpan(part: ToolPart): void {
    const state = part.state;
    if (state.status !== "completed" && state.status !== "error") return;
    const info = this.messages.get(part.messageID)?.info;
    const userMessageID = info?.role === "assistant" ? info.parentID : undefined;
    const turn = this.activeTurn(part.sessionID, userMessageID);
    const studioTool = isStudioTool(part.tool);

    if (turn) {
      turn.toolCalls += 1;
      turn.toolsUsed.add(part.tool);
      if (studioTool) turn.studioToolCalls += 1;
      if (state.status === "error") turn.toolErrors += 1;
    }

    this.capture("$ai_span", {
      $ai_trace_id: this.traceIdFor(turn, userMessageID ?? part.messageID),
      $ai_session_id: this.rootOf(part.sessionID),
      $ai_span_id: part.id,
      $ai_parent_id: part.messageID,
      $ai_span_name: part.tool,
      $ai_input_state: truncateValue(state.input),
      $ai_output_state:
        state.status === "completed" ? truncateText(state.output) : truncateText(state.error),
      $ai_latency: seconds(state.time.end - state.time.start),
      $ai_is_error: state.status === "error",
      $ai_error: state.status === "error" ? truncateText(state.error, 2_000) : undefined,
      span_kind: "tool",
      tool_name: part.tool,
      tool_call_id: part.callID,
      tool_title: state.status === "completed" ? state.title : undefined,
      tool_metadata: truncateValue(state.metadata, 8_000),
      tool_attachments:
        state.status === "completed"
          ? state.attachments?.map((file) => ({ mime: file.mime, filename: file.filename }))
          : undefined,
      studio_tool: studioTool,
      opencode_session_id: part.sessionID,
      started_at: iso(state.time.start),
      completed_at: iso(state.time.end),
      ...this.instructionProperties(turn),
      ...this.studioProperties(turn?.studio ?? null),
    });
  }

  // ── Lifecycle spans ─────────────────────────────────────────────────

  private span(
    sessionID: string,
    turn: Turn | undefined,
    span: {
      name: string;
      latencyMs: number;
      id?: string;
      parentID?: string;
      input?: unknown;
      output?: unknown;
      isError?: boolean;
      error?: string;
      properties?: Properties;
    },
  ): void {
    if (!turn) return;
    const finishedAt = this.now();
    this.capture("$ai_span", {
      $ai_trace_id: this.traceIdFor(turn, sessionID),
      $ai_session_id: this.rootOf(sessionID),
      $ai_span_id: span.id ?? `${span.name}-${sessionID}-${finishedAt}`,
      $ai_parent_id: span.parentID ?? this.nestingParent(sessionID, turn),
      $ai_span_name: span.name,
      $ai_input_state: span.input,
      $ai_output_state: span.output,
      $ai_latency: seconds(span.latencyMs),
      $ai_is_error: span.isError ?? false,
      $ai_error: span.error,
      opencode_session_id: sessionID,
      started_at: iso(finishedAt - span.latencyMs),
      completed_at: iso(finishedAt),
      ...span.properties,
      ...this.instructionProperties(turn),
      ...this.studioProperties(turn.studio),
    });
  }

  private onRetry(sessionID: string, status: { attempt: number; message: string; next: number }) {
    if (this.lastRetry.get(sessionID) === status.attempt) return;
    this.lastRetry.set(sessionID, status.attempt);
    const turn = this.activeTurn(sessionID);
    if (turn) turn.retries += 1;
    this.span(sessionID, turn, {
      name: "retry",
      latencyMs: 0,
      output: truncateText(status.message, 2_000),
      isError: true,
      error: truncateText(status.message, 2_000),
      properties: {
        span_kind: "retry",
        retry_attempt: status.attempt,
        retry_at: iso(status.next),
      },
    });
  }

  private onPermissionAsked(request: PermissionRequest): void {
    this.pending.set(request.id, {
      askedAt: this.now(),
      sessionID: request.sessionID,
      kind: "permission",
      name: `permission:${request.permission}`,
      input: truncateValue({
        permission: request.permission,
        patterns: request.patterns,
        always: request.always,
        metadata: request.metadata,
      }),
      parentID: request.tool?.messageID,
    });
  }

  private onQuestionAsked(request: QuestionRequest): void {
    this.pending.set(request.id, {
      askedAt: this.now(),
      sessionID: request.sessionID,
      kind: "question",
      name: "question",
      input: truncateValue(request.questions),
      parentID: request.tool?.messageID,
    });
  }

  private resolvePending(requestID: string, reply: unknown): void {
    const request = this.pending.get(requestID);
    if (!request) return;
    this.pending.delete(requestID);
    const waitMs = this.now() - request.askedAt;
    const turn = this.activeTurn(request.sessionID);
    const rejected = reply === "reject" || reply === "dismissed";
    if (turn) {
      turn.userWaitMs += waitMs;
      if (request.kind === "permission") {
        turn.permissions += 1;
        if (rejected) turn.permissionsRejected += 1;
      } else turn.questions += 1;
    }
    this.span(request.sessionID, turn, {
      name: request.name,
      id: requestID,
      parentID: request.parentID,
      latencyMs: waitMs,
      input: request.input,
      output: truncateValue(reply),
      properties: { span_kind: request.kind, user_wait_ms: waitMs, rejected },
    });
  }

  // ── Completion ──────────────────────────────────────────────────────

  private finishSession(sessionID: string): void {
    const root = this.rootOf(sessionID);
    if (root !== sessionID) {
      this.finishSubagent(sessionID);
      return;
    }
    const turns = this.turns.get(sessionID);
    this.turns.delete(sessionID);
    this.lastRetry.delete(sessionID);
    for (const [id, tracked] of this.messages) {
      if (tracked.info && this.rootOf(tracked.info.sessionID) === sessionID) {
        this.messages.delete(id);
      }
    }
    for (const [id, request] of this.pending) {
      if (this.rootOf(request.sessionID) === sessionID) this.pending.delete(id);
    }
    for (const turn of turns ?? []) this.emitTrace(sessionID, turn);
  }

  /** Finishes one turn that never went idle, leaving later prompts running. */
  private finishTurn(sessionID: string, turn: Turn): void {
    const queue = this.turns.get(sessionID);
    const index = queue?.indexOf(turn) ?? -1;
    if (!queue || index < 0) return;
    queue.splice(index, 1);
    if (queue.length === 0) this.turns.delete(sessionID);
    this.emitTrace(sessionID, turn);
  }

  private finishSubagent(sessionID: string): void {
    const turn = this.activeTurn(sessionID);
    const entries = [...this.messages.values()]
      .filter((tracked) => tracked.info?.sessionID === sessionID)
      .sort((left, right) => compareMessages(left.info as Message, right.info as Message));
    if (turn && entries.length) {
      turn.subagents += 1;
      const first = entries[0].info as Message;
      const prompt = entries.find((entry) => entry.info?.role === "user");
      const answers = entries.filter((entry) => entry.info?.role === "assistant");
      const last = answers[answers.length - 1];
      const agent = last?.info?.role === "assistant" ? last.info.agent : undefined;
      this.span(sessionID, turn, {
        name: `subagent:${agent ?? "task"}`,
        id: sessionID,
        parentID: this.nestingParent(this.sessionParents.get(sessionID) ?? sessionID, turn),
        latencyMs: this.now() - first.time.created,
        input: prompt ? truncateText(textOf(prompt.parts.values())) : undefined,
        output: last ? truncateText(textOf(last.parts.values())) : undefined,
        properties: {
          span_kind: "subagent",
          agent,
          session_title: this.sessionTitles.get(sessionID),
          generation_count: answers.length,
        },
      });
    }
    for (const [id, tracked] of this.messages) {
      if (tracked.info?.sessionID === sessionID) this.messages.delete(id);
    }
  }

  private emitTrace(sessionID: string, turn: Turn): void {
    const finishedAt = this.now();
    const { input } = turn;
    const diffs = [...turn.diffs.entries()];
    this.whenReady(turn, () =>
      this.capture("$ai_trace", {
        $ai_trace_id: turn.traceId ?? `unbound-${sessionID}-${turn.startedAt}`,
        $ai_session_id: sessionID,
        $ai_span_name: this.sessionTitles.get(sessionID) ?? "chat_turn",
        $ai_input_state: [
          ...(turn.system ? [{ role: "system", content: truncateText(turn.system) }] : []),
          { role: "user", content: input.text },
        ],
        $ai_output_state: turn.lastOutputText
          ? [{ role: "assistant", content: truncateText(turn.lastOutputText) }]
          : undefined,
        $ai_latency: seconds(finishedAt - turn.startedAt),
        $ai_is_error: turn.error !== null,
        $ai_error: turn.errorMessage ?? turn.error ?? undefined,
        error_name: turn.error ?? undefined,
        aborted: turn.aborted,
        session_title: this.sessionTitles.get(sessionID),
        provider: input.provider,
        model: input.model,
        agent: input.agent,
        variant: input.variant,
        prompt_chars: input.text.length,
        image_count: input.imageCount,
        wall_time_ms: finishedAt - turn.startedAt,
        time_to_first_output_ms:
          turn.firstOutputAt === null ? undefined : turn.firstOutputAt - turn.startedAt,
        user_wait_ms: turn.userWaitMs,
        generation_count: turn.generations,
        tool_call_count: turn.toolCalls,
        tool_error_count: turn.toolErrors,
        studio_tool_call_count: turn.studioToolCalls,
        tools_used: [...turn.toolsUsed].sort(),
        permission_count: turn.permissions,
        permission_rejected_count: turn.permissionsRejected,
        question_count: turn.questions,
        retry_count: turn.retries,
        compaction_count: turn.compactions,
        subagent_count: turn.subagents,
        reasoning_chars: turn.reasoningChars,
        tokens_input: turn.inputTokens,
        tokens_output: turn.outputTokens,
        tokens_reasoning: turn.reasoningTokens,
        cost_usd: turn.costUsd,
        todos: turn.todos.map((todo) => ({
          content: truncateText(todo.content, 500),
          status: todo.status,
          priority: todo.priority,
        })),
        // OpenCode reports the session's cumulative diff, not only this turn's.
        session_files_changed: diffs.map(([file, diff]) => ({
          file,
          status: diff.status,
          additions: diff.additions,
          deletions: diff.deletions,
          patch: diff.patch ? truncateText(diff.patch, MAX_PATCH_LENGTH) : undefined,
        })),
        session_files_changed_count: diffs.length,
        session_lines_added: diffs.reduce((total, [, diff]) => total + diff.additions, 0),
        session_lines_deleted: diffs.reduce((total, [, diff]) => total + diff.deletions, 0),
        started_at: iso(turn.startedAt),
        completed_at: iso(finishedAt),
        ...this.instructionProperties(turn),
        ...this.studioProperties(turn.studio),
      }),
    );
  }

  private studioProperties(studio: StudioAnalyticsContext | null): Properties {
    if (!studio) return { roblox_studio_connected: false };
    return {
      roblox_studio_connected: true,
      roblox_place_id: studio.placeId ?? undefined,
      roblox_place_name: studio.placeName ?? undefined,
      roblox_discovered_place_ids: [...studio.discoveredPlaceIds],
      roblox_studio_count: studio.discoveredCount,
    };
  }
}
