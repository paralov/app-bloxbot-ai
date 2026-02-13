import type {
  Agent,
  Event,
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

import { capture } from "@/lib/telemetry";
import type {
  AuthMethods,
  MessageWithParts,
  ModelInfo,
  OpenCodeStatus,
  ProviderInfo,
  StudioConnectionStatus,
} from "@/types";

// ── Tauri persistent store ──────────────────────────────────────────────

// ── Tauri persistent store (session data only) ──────────────────────────

const STORE_KEY = "session-ids";
const SESSION_MODELS_KEY = "session-models";
const tauriStore = new LazyStore("bloxbot-store.json");

async function loadOwnSessionIds(): Promise<Set<string>> {
  try {
    const raw = await tauriStore.get<string[]>(STORE_KEY);
    if (raw) return new Set(raw);
  } catch {
    // Corrupted data, start fresh
  }
  return new Set();
}

async function persistOwnSessionIds(ids: Set<string>): Promise<void> {
  await tauriStore.set(STORE_KEY, [...ids]);
}

async function loadSessionModels(): Promise<Record<string, string>> {
  try {
    const raw = await tauriStore.get<Record<string, string>>(SESSION_MODELS_KEY);
    if (raw) return raw;
  } catch {
    // Corrupted data, start fresh
  }
  return {};
}

// ── Rust-owned app config ───────────────────────────────────────────────
// All user preferences are stored in a single config.json managed by the
// Rust backend. The frontend reads/writes it through Tauri commands.

interface AppConfig {
  hasLaunched: boolean;
  lastModel: string | null;
  hiddenModels: string[];
}

async function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  return invoke<AppConfig>("set_config", { patch });
}

// ── Retry helper ────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseDelay?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelay = 1000 } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

// ── Store types ─────────────────────────────────────────────────────────

interface OpenCodeState {
  // ── Connection ──────────────────────────────────────────────────────
  /** Server status, updated via Tauri events from the backend. */
  status: OpenCodeStatus;
  port: number;
  serverError: string | null;
  client: OpencodeClient | null;

  // ── First-run / welcome ───────────────────────────────────────────
  /** Whether the user has seen the welcome screen before. null = not yet loaded from disk. */
  hasLaunched: boolean | null;

  // ── Init state ─────────────────────────────────────────────────────
  ready: boolean;
  initError: string | null;
  initGeneration: number;

  // ── Sessions ───────────────────────────────────────────────────────
  allSessions: Session[];
  activeSession: Session | null;
  sessionStatuses: Record<string, SessionStatus>;
  ownSessionIds: Set<string>;
  showAllSessions: boolean;

  // ── Messages ───────────────────────────────────────────────────────
  /** Ordered list of message IDs for the active session. */
  messageIds: string[];
  /** Message data keyed by ID — only the changed entry gets a new reference. */
  messagesById: Record<string, MessageWithParts>;
  isBusy: boolean;

  // ── Todos / Questions / Permissions ────────────────────────────────
  todos: Todo[];
  activeQuestion: QuestionRequest | null;
  activePermission: PermissionRequest | null;

  // ── Providers / Models ─────────────────────────────────────────────
  allProviders: ProviderInfo[];
  allModels: ModelInfo[];
  connectedProviders: string[];
  authMethods: AuthMethods;

  // ── Studio plugin ───────────────────────────────────────────────────
  /** Whether the .rbxmx plugin file is installed in Roblox's Plugins dir. null = not yet checked. */
  pluginInstalled: boolean | null;
  /** Status of the roblox-studio MCP server (polled via SDK). */
  studioStatus: StudioConnectionStatus;
  /** Error message when studioStatus is "failed". */
  studioError: string | null;
  /** Auto-picked MCP bridge URL for the Studio plugin to connect to. */
  mcpUrl: string | null;

  // ── User preferences ──────────────────────────────────────────────
  selectedModel: string | null;
  /** Per-session model overrides: sessionID -> "providerID/modelID" */
  sessionModels: Record<string, string>;
  agents: Agent[];
  selectedAgent: string | null;
  selectedVariant: string | null;
  hiddenModels: Set<string>;

  // ── Actions: server status (push-based from backend) ──────────────
  /** Called by OpenCodeProvider when it receives a Tauri status event. */
  setServerStatus: (status: OpenCodeStatus, port: number) => void;
  /** Fetch the initial status (in case events were emitted before the frontend loaded). */
  fetchInitialStatus: () => Promise<void>;
  setClient: (client: OpencodeClient | null) => void;
  /** Mark the welcome screen as dismissed. */
  dismissWelcome: () => void;
  /** Fetch the MCP server status from the OpenCode SDK (authoritative source).
   *  If the MCP server is connected, also polls the health endpoint for plugin status. */
  pollStudioStatus: () => Promise<void>;
  /** Disconnect then reconnect the MCP server via the OpenCode SDK. */
  restartMcpServer: () => Promise<void>;
  /** Check if the Studio plugin file is installed. */
  checkPluginInstalled: () => Promise<void>;
  /** Copy the bundled plugin into Roblox's Plugins directory. */
  installPlugin: () => Promise<void>;

  // ── Actions: init ─────────────────────────────────────────────────
  init: () => Promise<void>;

  // ── Actions: sessions ─────────────────────────────────────────────
  createSession: () => Promise<void>;
  selectSession: (sessionID: string) => Promise<void>;
  deleteSession: (sessionID: string) => Promise<void>;
  renameSession: (sessionID: string, title: string) => Promise<void>;
  setShowAllSessions: (show: boolean) => void;

  // ── Actions: messages ─────────────────────────────────────────────
  sendMessage: (text: string) => Promise<void>;
  abort: () => Promise<void>;

  // ── Actions: questions / permissions ───────────────────────────────
  answerQuestion: (requestID: string, answers: QuestionAnswer[]) => Promise<void>;
  rejectQuestion: (requestID: string) => Promise<void>;
  replyPermission: (requestID: string, reply: "once" | "always" | "reject") => Promise<void>;

  // ── Actions: auth / providers ─────────────────────────────────────
  setApiKey: (providerID: string, key: string) => Promise<void>;
  startOAuth: (
    providerID: string,
    methodIndex: number,
  ) => Promise<{ method: "auto" | "code"; instructions: string } | undefined>;
  /** Call after startOAuth to complete the flow. For "auto" flows this blocks until
   *  the user authorizes on the external site. For "code" flows, pass the user-entered code. */
  completeOAuth: (providerID: string, methodIndex: number, code?: string) => Promise<boolean>;
  /** Remove stored credentials for a provider. */
  disconnectProvider: (providerID: string) => Promise<void>;
  refreshProviders: () => Promise<void>;

  // ── Actions: preferences ──────────────────────────────────────────
  setSelectedModel: (modelID: string) => void;
  setSelectedAgent: (name: string) => void;
  setSelectedVariant: (variant: string | null) => void;
  toggleModelVisibility: (modelKey: string) => void;

  // ── Actions: SSE event handler ────────────────────────────────────
  handleEvent: (event: Event) => void;
}

// ── Derived selector helpers ────────────────────────────────────────────

/** Filtered session list (BloxBot-only or all) */
export function selectSessions(state: OpenCodeState): Session[] {
  return state.showAllSessions
    ? state.allSessions
    : state.allSessions.filter((s) => state.ownSessionIds.has(s.id));
}

/** Select a single message by ID (stable reference if that message hasn't changed). */
export function selectMessageById(id: string) {
  return (state: OpenCodeState): MessageWithParts | undefined => state.messagesById[id];
}

/** Available variants for the currently selected model */
export function selectAvailableVariants(state: OpenCodeState): string[] {
  if (!state.selectedModel) return [];
  const [, modelId] = state.selectedModel.split("/");
  const model = state.allModels.find((m) => m.id === modelId);
  return model?.variants ? Object.keys(model.variants) : [];
}

// ── Store ───────────────────────────────────────────────────────────────

export const useStore = create<OpenCodeState>((set, get) => {
  return {
    // ── Initial state ─────────────────────────────────────────────────
    status: "Stopped",
    port: 4096,
    serverError: null,
    client: null,

    hasLaunched: null,

    ready: false,
    initError: null,
    initGeneration: 0,

    allSessions: [],
    activeSession: null,
    sessionStatuses: {},
    ownSessionIds: new Set(),
    showAllSessions: false,

    messageIds: [],
    messagesById: {},
    isBusy: false,

    todos: [],
    activeQuestion: null,
    activePermission: null,

    allProviders: [],
    allModels: [],
    connectedProviders: [],
    authMethods: {},

    pluginInstalled: null,
    studioStatus: "unknown",
    studioError: null,
    mcpUrl: null,

    selectedModel: null,
    sessionModels: {},
    agents: [],
    selectedAgent: null,
    selectedVariant: null,
    hiddenModels: new Set(),

    // ── Server status (push-based from backend) ────────────────────

    setServerStatus: (status, port) => {
      const errorMsg = typeof status === "object" && "Error" in status ? status.Error : null;
      set({ status, port, serverError: errorMsg });
    },

    fetchInitialStatus: async () => {
      try {
        const [s, p] = await invoke<[OpenCodeStatus, number]>("get_opencode_status");
        set({ status: s, port: p });
      } catch (err) {
        console.error("Failed to fetch initial OpenCode status:", err);
      }
    },

    dismissWelcome: () => {
      set({ hasLaunched: true });
      patchConfig({ hasLaunched: true }).catch(() => {});
      capture("welcome_completed");
    },

    pollStudioStatus: async () => {
      try {
        const res = await invoke<{ status: string; error: string | null }>("poll_studio_status");
        const status = res.status as StudioConnectionStatus;
        const prev = get();
        // Only update store if the values actually changed — avoids re-renders
        if (status !== prev.studioStatus || res.error !== prev.studioError) {
          set({ studioStatus: status, studioError: res.error });
          if (status === "connected" && prev.studioStatus !== "connected") {
            capture("studio_connected");
          }
        }
      } catch {
        // Command failed (e.g. OpenCode not running yet)
      }
    },

    restartMcpServer: async () => {
      const c = get().client;
      if (!c) return;

      set({ studioStatus: "unknown", studioError: null });
      // Shut down the MCP server process via the launcher control endpoint
      // before asking OpenCode to disconnect, ensuring clean process cleanup.
      await invoke("shutdown_mcp").catch(() => {});
      try {
        await c.mcp.disconnect({ name: "roblox-studio" });
      } catch {
        // May already be disconnected — that's fine
      }
      try {
        // Reconnect with the existing config — OpenCode will re-spawn
        // the MCP server using the same config written at startup.
        await c.mcp.connect({ name: "roblox-studio" });
      } catch (err) {
        console.error("Failed to restart MCP server:", err);
        set({ studioStatus: "failed", studioError: String(err) });
      }
    },

    checkPluginInstalled: async () => {
      try {
        const installed = await invoke<boolean>("check_plugin_installed");
        set({ pluginInstalled: installed });
      } catch (err) {
        console.error("Failed to check plugin status:", err);
        set({ pluginInstalled: false });
      }
    },

    installPlugin: async () => {
      try {
        await invoke<string>("install_studio_plugin");
        set({ pluginInstalled: true });
        capture("plugin_installed");
      } catch (err) {
        console.error("Failed to install plugin:", err);
        throw err;
      }
    },

    setClient: (client) => {
      set({ client });
      if (!client) {
        set({
          ready: false,
          isBusy: false,
          activeQuestion: null,
          activePermission: null,
        });
      }
    },

    // ── Init (fetch all data from OpenCode server) ──────────────────

    init: async () => {
      const generation = get().initGeneration + 1;
      set({ initGeneration: generation, initError: null });

      const c = get().client;
      if (!c) return;

      try {
        await withRetry(async () => {
          // Check if a newer init has started
          if (get().initGeneration !== generation) return;

          const [sessionRes, providerListRes, statusRes, agentsRes, authMethodsRes] =
            await Promise.all([
              c.session.list({}),
              c.provider.list({}),
              c.session.status({}),
              c.app.agents({}).catch(() => ({ data: undefined })),
              c.provider.auth({}).catch(() => ({ data: undefined })),
            ]);

          // Stale check after await
          if (get().initGeneration !== generation) return;

          const updates: Partial<OpenCodeState> = { ready: true };
          let providerDefaults: Record<string, string> | undefined;

          if (sessionRes.data) {
            updates.allSessions = [...sessionRes.data].sort(
              (a, b) => b.time.created - a.time.created,
            );
          }

          if (providerListRes.data) {
            const { all, connected, default: defaults } = providerListRes.data;
            updates.connectedProviders = connected;
            updates.allProviders = all.map((p) => ({ id: p.id, name: p.name, env: p.env }));
            providerDefaults = defaults as Record<string, string> | undefined;

            const models: ModelInfo[] = [];
            for (const provider of all) {
              for (const model of Object.values(provider.models)) {
                models.push({
                  id: model.id,
                  name: model.name,
                  providerId: provider.id,
                  providerName: provider.name,
                  status: model.status,
                  variants: model.variants as Record<string, Record<string, unknown>> | undefined,
                });
              }
            }
            updates.allModels = models;
          }

          if (statusRes.data) {
            updates.sessionStatuses = statusRes.data;
          }

          if (agentsRes.data && Array.isArray(agentsRes.data)) {
            updates.agents = agentsRes.data;
            // Auto-select the first primary agent if none is selected
            if (!get().selectedAgent) {
              const primary = agentsRes.data.find((a: Agent) => a.mode === "primary" && !a.hidden);
              if (primary) {
                updates.selectedAgent = primary.name;
              }
            }
          }

          if (authMethodsRes.data) {
            updates.authMethods = authMethodsRes.data as AuthMethods;
          }

          // Load persisted data + check plugin status
          const [ownIds, savedSessionModels, pluginInstalled, cfg, mcpUrl] = await Promise.all([
            loadOwnSessionIds(),
            loadSessionModels(),
            invoke<boolean>("check_plugin_installed").catch(() => false),
            loadConfig(),
            invoke<string>("get_mcp_url").catch(() => null),
          ]);
          if (get().initGeneration !== generation) return;
          updates.ownSessionIds = ownIds;
          updates.hiddenModels = new Set(cfg.hiddenModels);
          updates.hasLaunched = cfg.hasLaunched;
          updates.sessionModels = savedSessionModels;
          updates.pluginInstalled = pluginInstalled;
          updates.mcpUrl = mcpUrl;

          // Model selection priority:
          // 1. cfg.lastModel (if its provider is still connected)
          // 2. providerDefaults[firstConnectedProvider]
          // 3. null (no model selected)
          const connected = updates.connectedProviders ?? get().connectedProviders;
          if (cfg.lastModel && connected.includes(cfg.lastModel.split("/")[0])) {
            updates.selectedModel = cfg.lastModel;
          } else if (providerDefaults) {
            // Find the first default that belongs to a connected provider
            const entry = Object.entries(providerDefaults).find(([pid]) => connected.includes(pid));
            if (entry) {
              updates.selectedModel = `${entry[0]}/${entry[1]}`;
            }
          }

          set(updates);
        });
      } catch (err) {
        if (get().initGeneration === generation) {
          set({
            initError: typeof err === "string" ? err : String(err),
          });
          console.error("Failed to initialize chat:", err);
        }
      }
    },

    // ── Session actions ─────────────────────────────────────────────

    createSession: async () => {
      const c = get().client;
      if (!c) return;
      try {
        const res = await c.session.create({});
        if (res.data) {
          const newSession = res.data;
          const ownIds = new Set(get().ownSessionIds);
          ownIds.add(newSession.id);
          await persistOwnSessionIds(ownIds);

          // Save the current model for the new session
          const currentModel = get().selectedModel;
          if (currentModel) {
            const next = { ...get().sessionModels, [newSession.id]: currentModel };
            set({ sessionModels: next });
            tauriStore.set(SESSION_MODELS_KEY, next).catch(() => {});
          }

          set((state) => ({
            ownSessionIds: ownIds,
            allSessions: state.allSessions.some((s) => s.id === newSession.id)
              ? state.allSessions
              : [newSession, ...state.allSessions],
            activeSession: newSession,
            messageIds: [],
            messagesById: {},
            todos: [],
            activeQuestion: null,
            activePermission: null,
            isBusy: false,
          }));
          capture("session_created");
        }
      } catch (err) {
        console.error("Failed to create session:", err);
      }
    },

    selectSession: async (sessionID) => {
      const c = get().client;
      if (!c) return;
      try {
        const [sessionRes, msgsRes] = await Promise.all([
          c.session.get({ sessionID }),
          c.session.messages({ sessionID }),
        ]);

        const updates: Partial<OpenCodeState> = {};

        if (sessionRes.data) {
          updates.activeSession = sessionRes.data;
        }
        if (msgsRes.data) {
          const byId: Record<string, MessageWithParts> = {};
          const ids: string[] = [];
          for (const m of msgsRes.data) {
            byId[m.info.id] = m;
            ids.push(m.info.id);
          }
          updates.messagesById = byId;
          updates.messageIds = ids;
        }

        // Fetch todos
        try {
          const todoRes = await c.session.todo({ sessionID });
          updates.todos = todoRes.data ?? [];
        } catch {
          updates.todos = [];
        }

        // Check for pending questions
        try {
          const qRes = await c.question.list({});
          if (qRes.data) {
            const pending = qRes.data.find((q: QuestionRequest) => q.sessionID === sessionID);
            updates.activeQuestion = pending ?? null;
          }
        } catch {
          updates.activeQuestion = null;
        }

        // Check for pending permissions
        try {
          const pRes = await c.permission.list({});
          if (pRes.data) {
            const pending = pRes.data.find((p: PermissionRequest) => p.sessionID === sessionID);
            updates.activePermission = pending ?? null;
          }
        } catch {
          updates.activePermission = null;
        }

        const status = get().sessionStatuses[sessionID];
        updates.isBusy = status?.type === "busy";

        // Restore per-session model if one was saved
        const savedModel = get().sessionModels[sessionID];
        if (savedModel) {
          updates.selectedModel = savedModel;
        }

        set(updates);
      } catch (err) {
        console.error("Failed to select session:", err);
      }
    },

    deleteSession: async (sessionID) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.session.delete({ sessionID });
        const ownIds = new Set(get().ownSessionIds);
        ownIds.delete(sessionID);
        await persistOwnSessionIds(ownIds);

        // Clean up per-session model
        const { [sessionID]: _removed, ...restModels } = get().sessionModels;
        set({ sessionModels: restModels });
        tauriStore.set(SESSION_MODELS_KEY, restModels).catch(() => {});

        set((state) => ({
          ownSessionIds: ownIds,
          allSessions: state.allSessions.filter((s) => s.id !== sessionID),
          ...(state.activeSession?.id === sessionID
            ? {
                activeSession: null,
                messageIds: [],
                messagesById: {},
                todos: [],
                activeQuestion: null,
                activePermission: null,
              }
            : {}),
        }));
      } catch (err) {
        console.error("Failed to delete session:", err);
      }
    },

    renameSession: async (sessionID, title) => {
      const c = get().client;
      if (!c) return;
      try {
        const res = await c.session.update({ sessionID, title });
        if (res.data) {
          const updated = res.data;
          set((state) => ({
            allSessions: state.allSessions.map((s) => (s.id === sessionID ? updated : s)),
            activeSession: state.activeSession?.id === sessionID ? updated : state.activeSession,
          }));
        }
      } catch (err) {
        console.error("Failed to rename session:", err);
      }
    },

    setShowAllSessions: (show) => set({ showAllSessions: show }),

    // ── Message actions ─────────────────────────────────────────────

    sendMessage: async (text) => {
      const { client: c, activeSession, selectedModel, selectedAgent, selectedVariant } = get();
      if (!c || !activeSession) return;

      set({ isBusy: true, todos: [] });

      try {
        const opts: Record<string, unknown> = {
          sessionID: activeSession.id,
          parts: [{ type: "text", text }],
        };

        if (selectedModel) {
          const [providerID, modelID] = selectedModel.split("/");
          if (providerID && modelID) {
            opts.model = { providerID, modelID };
          }
        }

        if (selectedAgent) {
          opts.agent = selectedAgent;
        }

        if (selectedVariant) {
          opts.variant = selectedVariant;
        }

        await c.session.promptAsync(opts as Parameters<typeof c.session.promptAsync>[0]);
        capture("message_sent", {
          model: selectedModel ?? undefined,
          agent: selectedAgent ?? undefined,
        });
      } catch (err) {
        console.error("Failed to send message:", err);
        set({ isBusy: false });
      }
    },

    abort: async () => {
      const { client: c, activeSession } = get();
      if (!c || !activeSession) return;
      try {
        await c.session.abort({ sessionID: activeSession.id });
      } catch (err) {
        console.error("Failed to abort:", err);
      } finally {
        set({ isBusy: false });
      }
    },

    // ── Question / Permission actions ───────────────────────────────

    answerQuestion: async (requestID, answers) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.question.reply({ requestID, answers });
        set({ activeQuestion: null });
      } catch (err) {
        console.error("Failed to answer question:", err);
      }
    },

    rejectQuestion: async (requestID) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.question.reject({ requestID });
        set({ activeQuestion: null });
      } catch (err) {
        console.error("Failed to reject question:", err);
      }
    },

    replyPermission: async (requestID, reply) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.permission.reply({ requestID, reply });
        set({ activePermission: null });
      } catch (err) {
        console.error("Failed to reply to permission:", err);
      }
    },

    // ── Auth / Providers ────────────────────────────────────────────

    setApiKey: async (providerID, key) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.auth.set({
          providerID,
          auth: { type: "api", key },
        });
        // Dispose cached instance so provider state is re-computed with new auth
        await c.instance.dispose();
        await get().refreshProviders();
        capture("provider_connected", { provider: providerID, method: "api_key" });
      } catch (err) {
        console.error("Failed to set API key:", err);
        throw err;
      }
    },

    disconnectProvider: async (providerID) => {
      const c = get().client;
      if (!c) return;
      try {
        await c.auth.remove({ providerID });
        await c.instance.dispose();
        await get().refreshProviders();
        capture("provider_disconnected", { provider: providerID });
      } catch (err) {
        console.error("Failed to disconnect provider:", err);
        throw err;
      }
    },

    startOAuth: async (providerID, methodIndex) => {
      const c = get().client;
      if (!c) return undefined;
      try {
        const res = await c.provider.oauth.authorize({
          providerID,
          method: methodIndex,
        });
        if (res.data) {
          await openUrl(res.data.url);
          return {
            method: res.data.method,
            instructions: res.data.instructions,
          };
        }
        return undefined;
      } catch (err) {
        console.error("Failed to start OAuth:", err);
        throw err;
      }
    },

    completeOAuth: async (providerID, methodIndex, code?) => {
      const c = get().client;
      if (!c) return false;
      try {
        const res = await c.provider.oauth.callback({
          providerID,
          method: methodIndex,
          ...(code ? { code } : {}),
        });
        // The OpenCode server caches provider state per-directory. After saving
        // new OAuth credentials, the cached state is stale. Dispose the instance
        // so the next API call re-initialises state with the new auth.
        await c.instance.dispose();
        await get().refreshProviders();
        if (res.data === true) {
          capture("provider_connected", { provider: providerID, method: "oauth" });
        }
        return res.data === true;
      } catch (err) {
        console.error("OAuth callback failed:", err);
        throw err;
      }
    },

    refreshProviders: async () => {
      const c = get().client;
      if (!c) return;
      try {
        const [provRes, authRes] = await Promise.all([
          c.provider.list({}),
          c.provider.auth({}).catch(() => ({ data: undefined })),
        ]);
        if (provRes.data) {
          const { all, connected } = provRes.data;
          const models: ModelInfo[] = [];
          for (const provider of all) {
            for (const model of Object.values(provider.models)) {
              models.push({
                id: model.id,
                name: model.name,
                providerId: provider.id,
                providerName: provider.name,
                status: model.status,
                variants: model.variants as Record<string, Record<string, unknown>> | undefined,
              });
            }
          }
          const updates: Partial<OpenCodeState> = {
            connectedProviders: connected,
            allProviders: all.map((p) => ({ id: p.id, name: p.name, env: p.env })),
            allModels: models,
          };
          if (authRes.data) {
            updates.authMethods = authRes.data as AuthMethods;
          }
          set(updates);
        }
      } catch {
        // Non-critical
      }
    },

    // ── Preferences ─────────────────────────────────────────────────

    setSelectedModel: (modelID) => {
      set({ selectedModel: modelID });

      // Persist as global last-used model
      patchConfig({ lastModel: modelID }).catch(() => {});

      // Persist per-session override
      const activeSession = get().activeSession;
      if (activeSession) {
        const next = { ...get().sessionModels, [activeSession.id]: modelID };
        set({ sessionModels: next });
        tauriStore.set(SESSION_MODELS_KEY, next).catch(() => {});
      }
    },
    setSelectedAgent: (name) => set({ selectedAgent: name }),
    setSelectedVariant: (variant) => set({ selectedVariant: variant }),

    toggleModelVisibility: (modelKey) => {
      const next = new Set(get().hiddenModels);
      if (next.has(modelKey)) {
        next.delete(modelKey);
      } else {
        next.add(modelKey);
      }
      patchConfig({ hiddenModels: [...next] }).catch(() => {});
      set({ hiddenModels: next });
    },

    // ── SSE event handler ───────────────────────────────────────────

    handleEvent: (event: Event) => {
      if (!event || !event.type) return;

      const currentSessionId = get().activeSession?.id ?? null;

      switch (event.type) {
        case "session.created": {
          const session = event.properties.info;
          if (session) {
            set((state) => ({
              allSessions: state.allSessions.some((s) => s.id === session.id)
                ? state.allSessions
                : [session, ...state.allSessions],
            }));
          }
          break;
        }
        case "session.updated": {
          const session = event.properties.info;
          if (session) {
            set((state) => ({
              allSessions: state.allSessions.map((s) => (s.id === session.id ? session : s)),
              activeSession: session.id === currentSessionId ? session : state.activeSession,
            }));
          }
          break;
        }
        case "session.deleted": {
          const session = event.properties.info;
          if (session) {
            set((state) => ({
              allSessions: state.allSessions.filter((s) => s.id !== session.id),
              activeSession: session.id === currentSessionId ? null : state.activeSession,
            }));
          }
          break;
        }
        case "session.status": {
          const { sessionID, status } = event.properties;
          if (sessionID && status) {
            set((state) => {
              const prevStatus = state.sessionStatuses[sessionID];
              const newBusy =
                sessionID === currentSessionId ? status.type === "busy" : state.isBusy;
              // Skip update if nothing actually changed
              if (prevStatus?.type === status.type && state.isBusy === newBusy) return state;
              return {
                sessionStatuses: { ...state.sessionStatuses, [sessionID]: status },
                isBusy: newBusy,
              };
            });
          }
          break;
        }
        case "session.idle": {
          const { sessionID } = event.properties;
          if (sessionID) {
            set((state) => {
              const prevStatus = state.sessionStatuses[sessionID];
              const newBusy = sessionID === currentSessionId ? false : state.isBusy;
              // Skip update if already idle
              if (prevStatus?.type === "idle" && state.isBusy === newBusy) return state;
              return {
                sessionStatuses: {
                  ...state.sessionStatuses,
                  [sessionID]: { type: "idle" },
                },
                isBusy: newBusy,
              };
            });
          }
          break;
        }
        case "message.updated": {
          const info = event.properties.info as Message;
          if (info && info.sessionID === currentSessionId) {
            set((state) => {
              const existing = state.messagesById[info.id];
              if (existing) {
                // Update only this message entry — other entries keep their references
                return {
                  messagesById: {
                    ...state.messagesById,
                    [info.id]: { ...existing, info },
                  },
                };
              }
              // New message
              return {
                messageIds: [...state.messageIds, info.id],
                messagesById: {
                  ...state.messagesById,
                  [info.id]: { info, parts: [] },
                },
              };
            });
          }
          break;
        }
        case "message.part.updated": {
          const part = event.properties.part as Part;
          if (part && part.sessionID === currentSessionId) {
            set((state) => {
              const msg = state.messagesById[part.messageID];
              if (!msg) return state;
              const partIdx = msg.parts.findIndex((p) => p.id === part.id);
              let newParts: Part[];
              if (partIdx >= 0) {
                newParts = [...msg.parts];
                newParts[partIdx] = part;
              } else {
                newParts = [...msg.parts, part];
              }
              // Only the one message entry gets a new reference
              return {
                messagesById: {
                  ...state.messagesById,
                  [part.messageID]: { ...msg, parts: newParts },
                },
              };
            });
          }
          break;
        }
        case "message.removed": {
          const { sessionID, messageID } = event.properties;
          if (sessionID === currentSessionId && messageID) {
            set((state) => {
              const { [messageID as string]: _removed, ...rest } = state.messagesById;
              return {
                messageIds: state.messageIds.filter((id) => id !== messageID),
                messagesById: rest,
              };
            });
          }
          break;
        }
        case "message.part.removed": {
          const { sessionID, messageID, partID } = event.properties;
          if (sessionID === currentSessionId && messageID) {
            set((state) => {
              const msg = state.messagesById[messageID as string];
              if (!msg) return state;
              return {
                messagesById: {
                  ...state.messagesById,
                  [messageID as string]: {
                    ...msg,
                    parts: msg.parts.filter((p) => p.id !== partID),
                  },
                },
              };
            });
          }
          break;
        }

        // ── Todos ──────────────────────────────────────────────────
        case "todo.updated": {
          const { sessionID, todos: newTodos } = event.properties;
          if (sessionID === currentSessionId && Array.isArray(newTodos)) {
            set({ todos: newTodos });
          }
          break;
        }

        // ── Questions ──────────────────────────────────────────────
        case "question.asked": {
          const qr = event.properties as unknown as QuestionRequest;
          if (qr && qr.sessionID === currentSessionId) {
            set({ activeQuestion: qr });
          }
          break;
        }
        case "question.replied":
        case "question.rejected": {
          const { sessionID } = event.properties;
          if (sessionID === currentSessionId) {
            set({ activeQuestion: null });
          }
          break;
        }

        // ── Permissions ────────────────────────────────────────────
        case "permission.asked": {
          const pr = event.properties as unknown as PermissionRequest;
          if (pr && pr.sessionID === currentSessionId) {
            set({ activePermission: pr });
          }
          break;
        }
        case "permission.replied": {
          const { sessionID } = event.properties;
          if (sessionID === currentSessionId) {
            set({ activePermission: null });
          }
          break;
        }

        // ── MCP ─────────────────────────────────────────────────
        case "mcp.tools.changed": {
          // Refetch MCP status when tools change (server connect/disconnect)
          get().pollStudioStatus();
          break;
        }
      }
    },
  };
});
