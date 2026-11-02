import {
  type FormInfo,
  type IntegrationInfo,
  type IntegrationMethod,
  type ModelInfo,
  OpenCode,
  type OpenCodeClient,
  type SessionInfo,
  type SessionMessageInfo,
  type SessionStructuredError,
  type PermissionRequest as V2PermissionRequest,
} from "@opencode/client";

import { EventTranslator } from "./events";
import {
  historyToMessages,
  todosFromHistory,
  toFormAnswer,
  toModelError,
  toolName,
  toQuestionRequest,
  toSession,
} from "./messages";
import type {
  AssistantMessage,
  Command,
  Event,
  McpStatus,
  Model,
  PermissionRequest,
  PermissionRuleset,
  Provider,
  ProviderAuthMethod,
  ProviderListResponse,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "./types";

export interface RequestOptions {
  throwOnError?: boolean;
  signal?: AbortSignal;
}

/** The SDK-style result. `data` is only missing after a failure without `throwOnError`. */
export type Result<T> = { data: T; error?: unknown };

type FilePromptPart = { type: "file"; mime: string; url: string; filename?: string };
type TextPromptPart = { type: "text"; text: string };

export interface PromptInput {
  sessionID: string;
  model?: { providerID: string; modelID: string };
  variant?: string;
  system?: string;
  parts: ReadonlyArray<TextPromptPart | FilePromptPart | { type: string; [key: string]: unknown }>;
  format?: { type: "json_schema"; schema: unknown; retryCount?: number };
}

export interface PromptResult {
  info: AssistantMessage & { structured?: unknown };
  parts: [];
}

const INSTRUCTIONS_KEY = "bloxbot.prompt";
const OAUTH_POLL_MS = 1000;
const PAGE_SIZE = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle<T>(
  options: RequestOptions | undefined,
  run: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { data: await run() };
  } catch (error) {
    if (options?.throwOnError) throw error;
    return { data: undefined as T, error };
  }
}

function toRuleset(rules: PermissionRuleset) {
  return rules.map((rule) => ({
    action:
      rule.permission === "bash"
        ? "shell"
        : rule.permission === "task"
          ? "subagent"
          : rule.permission,
    resource: rule.pattern,
    effect: rule.action,
  }));
}

function toPermissionRequest(request: V2PermissionRequest): PermissionRequest {
  return {
    id: request.id,
    sessionID: request.sessionID,
    permission: toolName(request.action),
    patterns: [...request.resources],
    metadata: request.metadata ?? {},
    always: [...(request.save ?? [])],
  };
}

function toAuthMethods(methods: ReadonlyArray<IntegrationMethod>): ProviderAuthMethod[] {
  return connectable(methods).map((method): ProviderAuthMethod => {
    if (method.type === "key") return { type: "api", label: method.label ?? "API key" };
    return {
      type: "oauth",
      label: method.label,
      prompts: (method.form ?? [])
        .filter((field) => !("hidden" in field && field.hidden))
        .map((field) => {
          const when = "when" in field ? field.when?.[0] : undefined;
          const base = {
            key: field.key,
            message: field.title ?? field.key,
            ...(when && typeof when.value === "string"
              ? { when: { key: when.key, op: when.op, value: when.value } }
              : {}),
          };
          return "options" in field && field.options?.length
            ? {
                ...base,
                type: "select" as const,
                options: field.options.map((option) => ({
                  label: option.label,
                  value: option.value,
                  hint: option.description,
                })),
              }
            : {
                ...base,
                type: "text" as const,
                placeholder: "placeholder" in field ? field.placeholder : undefined,
              };
        }),
    };
  });
}

type ConnectableMethod = Extract<IntegrationMethod, { type: "key" | "oauth" }>;

/** The ways to connect that BloxBot can offer, in the order the index in the UI refers to. */
function connectable(methods: ReadonlyArray<IntegrationMethod>): ConnectableMethod[] {
  return methods.filter(
    (method): method is ConnectableMethod => method.type === "key" || method.type === "oauth",
  );
}

function toModel(model: ModelInfo): Model {
  const cost = model.cost[0];
  const media = (list: ReadonlyArray<string>) => ({
    text: list.includes("text"),
    audio: list.includes("audio"),
    image: list.includes("image"),
    video: list.includes("video"),
    pdf: list.includes("pdf"),
  });
  const { capabilities } = model;
  return {
    id: model.modelID,
    providerID: model.providerID,
    api: { id: model.modelID, url: "", npm: model.package ?? "" },
    name: model.name,
    family: model.family,
    capabilities: {
      temperature: capabilities.temperature ?? false,
      reasoning: "reasoning" in capabilities && Boolean(capabilities.reasoning),
      attachment: capabilities.input.length > 1,
      toolcall: capabilities.tools,
      input: media(capabilities.input),
      output: media(capabilities.output),
      interleaved: false,
    },
    cost: {
      input: cost?.input ?? 0,
      output: cost?.output ?? 0,
      cache: { read: cost?.cache.read ?? 0, write: cost?.cache.write ?? 0 },
    },
    limit: model.limit,
    status: model.status,
    options: {},
    headers: {},
    release_date: "",
    variants:
      model.variants.length > 0
        ? Object.fromEntries(
            model.variants.map((variant) => [variant.id, (variant.settings ?? {}) as object]),
          )
        : undefined,
  } as Model;
}

function providerSource(integration: IntegrationInfo): Provider["source"] {
  if (integration.connections.some((connection) => connection.type === "credential")) return "api";
  if (integration.connections.some((connection) => connection.type === "env")) return "env";
  return "custom";
}

function toProviderList(
  integrations: ReadonlyArray<IntegrationInfo>,
  models: ReadonlyArray<ModelInfo>,
): ProviderListResponse {
  const byProvider = new Map<string, Record<string, Model>>();
  for (const model of models) {
    if (!model.enabled) continue;
    const provider = byProvider.get(model.providerID) ?? {};
    provider[model.modelID] = toModel(model);
    byProvider.set(model.providerID, provider);
  }
  const all = integrations.map(
    (integration): Provider => ({
      id: integration.id,
      name: integration.id === "opencode" ? "OpenCode Zen" : integration.name,
      source: providerSource(integration),
      env: integration.methods.flatMap((method) =>
        method.type === "env" ? [...method.names] : [],
      ),
      options: {},
      models: byProvider.get(integration.id) ?? {},
    }),
  );
  return {
    all,
    default: {},
    connected: all.filter((provider) => Object.keys(provider.models).length > 0).map((p) => p.id),
  } as ProviderListResponse;
}

/**
 * The OpenCode API as the app uses it, on top of OpenCode 2's client. It keeps the call shapes and
 * the data model in `types.ts`, so OpenCode's API changes stop at this file and `events.ts`.
 */
export function createOpencodeClient(options: {
  baseUrl: string;
  directory?: string;
  headers?: Record<string, string>;
}) {
  const api: OpenCodeClient = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers });
  const translator = new EventTranslator();
  const location = options.directory ? { directory: options.directory } : undefined;

  const forms = new Map<string, FormInfo>();
  const permissionSessions = new Map<string, string>();
  const oauthAttempts = new Map<string, string>();
  const sessionModels = new Map<string, string>();
  const exchanges = new Map<string, string[]>();

  const remember = (info: SessionInfo): Session => {
    const session = toSession(info);
    translator.rememberSession(session);
    return session;
  };

  // A cursor carries its query, and OpenCode rejects one sent with the query's filters again.
  const history = async (sessionID: string): Promise<SessionMessageInfo[]> => {
    const entries: SessionMessageInfo[] = [];
    let page = await api.message.list({ sessionID, order: "asc", limit: PAGE_SIZE });
    for (;;) {
      entries.push(...page.data);
      if (page.data.length < PAGE_SIZE || !page.cursor.next) return entries;
      page = await api.message.list({ sessionID, limit: PAGE_SIZE, cursor: page.cursor.next });
    }
  };

  const listSessions = async (archived: boolean): Promise<Session[]> => {
    const sessions: Session[] = [];
    let page = await api.session.list({ archived, limit: PAGE_SIZE });
    for (;;) {
      sessions.push(...page.data.map(remember));
      if (page.data.length < PAGE_SIZE || !page.cursor.next) return sessions;
      page = await api.session.list({ limit: PAGE_SIZE, cursor: page.cursor.next });
    }
  };

  const integration = async (providerID: string) =>
    api.integration.get({ integrationID: providerID, location }).then((result) => result.data);

  /** Applies the prompt's model and instructions, which OpenCode 2 keeps on the session. */
  const prepareTurn = async (input: PromptInput) => {
    const { sessionID, model, variant, system } = input;
    if (model) {
      const key = `${model.providerID}/${model.modelID}#${variant ?? ""}`;
      if (sessionModels.get(sessionID) !== key) {
        await api.session.switchModel({
          sessionID,
          model: { id: model.modelID, providerID: model.providerID, variant },
        });
        sessionModels.set(sessionID, key);
      }
    }
    if (system) {
      await api.experimental.session.instructions.entry.put({
        sessionID,
        key: INSTRUCTIONS_KEY,
        value: system,
      });
    } else {
      await api.experimental.session.instructions.entry
        .remove({ sessionID, key: INSTRUCTIONS_KEY })
        .catch(() => undefined);
    }
  };

  const sendPrompt = async (input: PromptInput, suffix = "") => {
    await prepareTurn(input);
    const text = input.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const files = input.parts.flatMap((part) =>
      part.type === "file"
        ? [{ uri: part.url as string, name: part.filename as string | undefined }]
        : [],
    );
    return api.session.prompt({
      sessionID: input.sessionID,
      text: `${text}${suffix}`,
      files: files.length > 0 ? files : undefined,
      resume: true,
    });
  };

  /**
   * One model reply that runs no tools and leaves the chat's history alone. Generate requests keep
   * the session's tools, which OpenCode's free tier requires. Nothing is remembered between them,
   * so a follow-up carries the earlier exchange itself.
   */
  const prompt = async (input: PromptInput): Promise<PromptResult> => {
    await prepareTurn(input);
    const { sessionID, model, format } = input;
    const info = {
      role: "assistant",
      sessionID,
      modelID: model?.modelID,
      providerID: model?.providerID,
    } as PromptResult["info"];
    const instruction = format
      ? `\n\nAnswer with only one JSON object matching this JSON schema, with no other text:\n${JSON.stringify(format.schema)}`
      : "";
    const asked = input.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    const earlier = exchanges.get(sessionID) ?? [];
    const attempts = (format?.retryCount ?? 0) + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let reply: string;
      try {
        ({ text: reply } = await api.session.generate({
          sessionID,
          prompt: [...earlier, `${asked}${instruction}`].join("\n\n"),
        }));
      } catch (error) {
        info.error = toModelError(toStructuredError(error));
        return { info, parts: [] };
      }
      if (!format) return { info, parts: [] };
      const structured = parseJsonObject(reply);
      if (structured !== undefined) {
        info.structured = structured;
        return { info, parts: [] };
      }
      earlier.push(`You were asked: ${asked}`, `You replied: ${reply}`);
      exchanges.set(sessionID, earlier);
    }
    info.error = {
      name: "StructuredOutputError",
      data: { message: "The model did not return the requested JSON.", retries: attempts },
    } as AssistantMessage["error"];
    return { info, parts: [] };
  };

  const client = {
    session: {
      create: (
        input: {
          title?: string;
          parentID?: string;
          metadata?: Record<string, string | number | boolean>;
          permission?: PermissionRuleset;
        },
        requestOptions?: RequestOptions,
      ) =>
        settle(requestOptions, async () =>
          remember(
            await api.session.create({
              title: input.title,
              parentID: input.parentID,
              metadata: input.metadata,
              location,
              permissions: input.permission ? toRuleset(input.permission) : undefined,
            }),
          ),
        ),
      update: (
        input: { sessionID: string; title?: string; time?: { archived?: number } },
        requestOptions?: RequestOptions,
      ) =>
        settle(requestOptions, async () => {
          await api.session.update({
            sessionID: input.sessionID,
            title: input.title,
            archived: input.time ? Boolean(input.time.archived) : undefined,
          });
          return remember(await api.session.get({ sessionID: input.sessionID }));
        }),
      delete: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.session.remove({ sessionID: input.sessionID });
          translator.forgetSession(input.sessionID);
          sessionModels.delete(input.sessionID);
          exchanges.delete(input.sessionID);
          return true;
        }),
      status: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const active = await api.session.active();
          return Object.fromEntries(
            Object.keys(active).map((sessionID): [string, SessionStatus] => [
              sessionID,
              { type: "busy" },
            ]),
          ) as Record<string, SessionStatus>;
        }),
      messages: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () =>
          historyToMessages(input.sessionID, await history(input.sessionID)),
        ),
      todo: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(
          requestOptions,
          async (): Promise<Todo[]> => todosFromHistory(await history(input.sessionID)),
        ),
      abort: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.session.interrupt({ sessionID: input.sessionID });
          return true;
        }),
      promptAsync: (input: PromptInput, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await sendPrompt(input);
        }),
      prompt: (input: PromptInput, requestOptions?: RequestOptions) =>
        settle(requestOptions, () => prompt(input)),
      /** Runs one of OpenCode's slash commands, such as /goal, instead of sending it as a prompt. */
      command: (input: PromptInput & { name: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await prepareTurn(input);
          await api.session.command({
            sessionID: input.sessionID,
            name: input.name,
            text: input.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
            files: input.parts.flatMap((part) =>
              part.type === "file"
                ? [{ uri: part.url as string, name: part.filename as string | undefined }]
                : [],
            ),
          });
        }),
      compact: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.session.compact({ sessionID: input.sessionID });
        }),
      fork: (input: { sessionID: string; before?: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => remember(await api.session.fork(input))),
      /** Rewinds to before a message, and puts the files back. Sending again makes it final. */
      undo: (input: { sessionID: string; messageID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.session.interrupt({ sessionID: input.sessionID });
          await api.experimental.session.wait({ sessionID: input.sessionID });
          await api.session.revert.stage(input);
        }),
      redo: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.session.revert.clear(input);
        }),
      /** The chat as OpenCode stores it, for saving to a file. */
      exportData: (input: { sessionID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => ({
          info: await api.session.get({ sessionID: input.sessionID }),
          messages: await history(input.sessionID),
        })),
    },
    experimental: {
      session: {
        /** Every session. OpenCode 2 lists archived sessions on their own, so this asks twice. */
        list: (_input: { archived?: boolean } = {}, requestOptions?: RequestOptions) =>
          settle(requestOptions, async () => {
            const [active, archived] = await Promise.all([listSessions(false), listSessions(true)]);
            return [...active, ...archived];
          }),
      },
    },
    event: {
      subscribe: async (_input: object = {}, requestOptions?: RequestOptions) => {
        const stream = api.event.subscribe({ signal: requestOptions?.signal });
        async function* translated(): AsyncGenerator<Event> {
          for await (const event of stream) {
            yield* translator.translate(event);
          }
        }
        return { stream: translated() };
      },
    },
    location: {
      /** Rereads config, commands, agents and skills without restarting. */
      reload: (requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.location.reload();
        }),
    },
    command: {
      list: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const commands = await api.command.list({ location });
          return commands.data.map(
            (command): Command => ({
              name: command.name,
              description: command.description,
              template: "",
              hints: [],
            }),
          );
        }),
    },
    mcp: {
      status: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const servers = await api.mcp.list({ location });
          return Object.fromEntries(
            servers.data.map((server) => [server.name, server.status as McpStatus]),
          );
        }),
      connect: (input: { name: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.experimental.mcp.connect({ server: input.name, location });
          return true;
        }),
    },
    instance: {
      dispose: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          await api.location.reload();
          return true;
        }),
    },
    provider: {
      list: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const [integrations, models] = await Promise.all([
            api.integration.list({ location }),
            api.model.list({ location }),
          ]);
          return toProviderList(integrations.data, models.data);
        }),
      auth: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const integrations = await api.integration.list({ location });
          return Object.fromEntries(
            integrations.data.map((item) => [item.id, toAuthMethods(item.methods)]),
          ) as Record<string, ProviderAuthMethod[]>;
        }),
      oauth: {
        authorize: (
          input: { providerID: string; method: number; inputs?: Record<string, string> },
          requestOptions?: RequestOptions,
        ) =>
          settle(requestOptions, async () => {
            const { methods } = await integration(input.providerID);
            const method = connectable(methods)[input.method];
            if (method?.type !== "oauth") throw new Error("This sign-in method isn't available.");
            const attempt = await api.integration.oauth.connect({
              integrationID: input.providerID,
              methodID: method.id,
              answer: input.inputs,
              location,
            });
            oauthAttempts.set(input.providerID, attempt.data.attemptID);
            return {
              url: attempt.data.url,
              method: attempt.data.mode === "code" ? ("code" as const) : ("auto" as const),
              instructions: attempt.data.instructions,
            };
          }),
        callback: (
          input: { providerID: string; method: number; code?: string },
          requestOptions?: RequestOptions,
        ) =>
          settle(requestOptions, async () => {
            const attemptID = oauthAttempts.get(input.providerID);
            if (!attemptID) throw new Error("Start the sign-in again.");
            const ids = { integrationID: input.providerID, attemptID, location };
            if (input.code) {
              await api.integration.oauth.complete({ ...ids, code: input.code });
              oauthAttempts.delete(input.providerID);
              return true;
            }
            for (;;) {
              const { data: status } = await api.integration.oauth.status(ids);
              if (status.status === "complete") break;
              if (status.status === "failed") throw new Error(status.message);
              if (status.status === "expired") throw new Error("The sign-in timed out.");
              await sleep(OAUTH_POLL_MS);
            }
            await api.integration.oauth.complete(ids).catch(() => undefined);
            oauthAttempts.delete(input.providerID);
            return true;
          }),
      },
    },
    auth: {
      set: (
        input: { providerID: string; auth: { type: "api"; key: string } },
        requestOptions?: RequestOptions,
      ) =>
        settle(requestOptions, async () => {
          await api.integration.connect.key({
            integrationID: input.providerID,
            key: input.auth.key,
            location,
          });
          return true;
        }),
      remove: (input: { providerID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const { connections } = await integration(input.providerID);
          await Promise.all(
            connections.flatMap((connection) =>
              connection.type === "credential"
                ? [api.credential.remove({ credentialID: connection.id })]
                : [],
            ),
          );
          return true;
        }),
    },
    permission: {
      list: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const requests = await api.permission.request.list({ location });
          for (const request of requests.data) {
            permissionSessions.set(request.id, request.sessionID);
          }
          return requests.data.map(toPermissionRequest);
        }),
      reply: (
        input: { requestID: string; reply: "once" | "always" | "reject"; message?: string },
        requestOptions?: RequestOptions,
      ) =>
        settle(requestOptions, async () => {
          let sessionID = permissionSessions.get(input.requestID);
          if (!sessionID) {
            const requests = await api.permission.request.list({ location });
            sessionID = requests.data.find((request) => request.id === input.requestID)?.sessionID;
          }
          if (!sessionID) throw new Error("This approval request is no longer open.");
          await api.permission.reply({
            sessionID,
            requestID: input.requestID,
            decision: input.reply,
            message: input.message,
          });
          permissionSessions.delete(input.requestID);
          return true;
        }),
    },
    question: {
      list: (_input: object = {}, requestOptions?: RequestOptions) =>
        settle(requestOptions, async (): Promise<QuestionRequest[]> => {
          const open = await api.form.list({ location });
          for (const form of open.data) forms.set(form.id, form);
          return open.data.map(toQuestionRequest);
        }),
      reply: (
        input: { requestID: string; answers: QuestionAnswer[] },
        requestOptions?: RequestOptions,
      ) =>
        settle(requestOptions, async () => {
          const form = await findForm(input.requestID);
          await api.session.form.reply({
            sessionID: form.sessionID,
            formID: form.id,
            answer: toFormAnswer(form, input.answers),
          });
          forms.delete(form.id);
          return true;
        }),
      reject: (input: { requestID: string }, requestOptions?: RequestOptions) =>
        settle(requestOptions, async () => {
          const form = await findForm(input.requestID);
          await api.session.form.cancel({ sessionID: form.sessionID, formID: form.id });
          forms.delete(form.id);
          return true;
        }),
    },
  };

  const findForm = async (formID: string): Promise<FormInfo> => {
    const known = forms.get(formID);
    if (known) return known;
    const open = await api.form.list({ location });
    const form = open.data.find((candidate) => candidate.id === formID);
    if (!form) throw new Error("This question is no longer open.");
    return form;
  };

  return client;
}

export type OpencodeClient = ReturnType<typeof createOpencodeClient>;

/** A failed request in the shape a failed turn reports, so callers handle both the same way. */
function toStructuredError(error: unknown): SessionStructuredError {
  const fields = error as {
    reason?: string;
    message?: string;
    status?: number;
    retryAfterMs?: number;
  };
  return {
    type: fields.reason ?? "unknown",
    message: fields.message ?? String(error),
    status: fields.status,
    retryAfterMs: fields.retryAfterMs,
  };
}

/** The JSON object in a model's reply, which some models wrap in a code fence or a sentence. */
export function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
