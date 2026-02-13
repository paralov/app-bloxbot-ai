import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { selectAvailableVariants, useStore } from "@/stores/opencode";
import type { ModelInfo } from "@/types";

// Known provider metadata for inline auth prompt
const PROVIDER_META: Record<string, { placeholder: string; helpUrl: string }> = {
  anthropic: { placeholder: "sk-ant-...", helpUrl: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-...", helpUrl: "https://platform.openai.com/api-keys" },
  google: { placeholder: "AIza...", helpUrl: "https://aistudio.google.com/app/apikey" },
};

// ── Send/Abort button — isolated to avoid re-rendering the entire ChatInput ──

/** Tiny component that subscribes to isBusy + studioStatus so the rest
 *  of ChatInput (model picker, agent picker, auth UI) doesn't re-render
 *  on every busy toggle or studio status poll. */
const SendButton = memo(function SendButton({
  text,
  onSend,
}: {
  text: string;
  onSend: () => void;
}) {
  const isBusy = useStore((s) => s.isBusy);
  const studioStatus = useStore((s) => s.studioStatus);
  const studioConnected = studioStatus === "connected";
  const canSend = !isBusy && studioConnected;

  return (
    <>
      {isBusy ? (
        <button
          onClick={() => useStore.getState().abort()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Stop"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={!text.trim() || !canSend}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-opacity disabled:opacity-30"
          title={studioConnected ? "Send" : "Roblox Studio is not connected"}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
      )}
    </>
  );
});

const StatusHint = memo(function StatusHint() {
  const studioStatus = useStore((s) => s.studioStatus);
  return (
    <div className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
      {studioStatus === "connected"
        ? "Shift+Enter for new line"
        : "Waiting for Roblox Studio to connect..."}
    </div>
  );
});

function ChatInput() {
  const allModels = useStore((s) => s.allModels);
  const connectedProviders = useStore((s) => s.connectedProviders);
  const hiddenModels = useStore((s) => s.hiddenModels);
  const selectedModel = useStore((s) => s.selectedModel);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.selectedAgent);
  const setSelectedAgent = useStore((s) => s.setSelectedAgent);
  const selectedVariant = useStore((s) => s.selectedVariant);
  const setSelectedVariant = useStore((s) => s.setSelectedVariant);
  const availableVariants = useStore(useShallow(selectAvailableVariants));
  const authMethods = useStore((s) => s.authMethods);

  const [text, setText] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);

  // Clean up OAuth on unmount
  useEffect(() => {
    return () => {
      oauthAbortRef.current?.abort();
    };
  }, []);

  // Inline auth state (shown when user clicks an unconnected model)
  const [authProviderId, setAuthProviderId] = useState<string | null>(null);
  const [authProviderName, setAuthProviderName] = useState("");
  const [pendingModelId, setPendingModelId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [authOauthLoading, setAuthOauthLoading] = useState(false);
  const [authOauthInstructions, setAuthOauthInstructions] = useState<string | null>(null);
  const [authOauthMethod, setAuthOauthMethod] = useState<"auto" | "code" | null>(null);
  const [authOauthCodeInput, setAuthOauthCodeInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  // Auto-resize textarea
  // biome-ignore lint/correctness/useExhaustiveDependencies: text triggers resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  // Close pickers on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
        setModelSearch("");
        setAuthProviderId(null);
      }
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false);
      }
    }
    if (showModelPicker || showAgentPicker) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showModelPicker, showAgentPicker]);

  // When connectedProviders changes, check if we just connected the pending provider
  useEffect(() => {
    if (authProviderId && connectedProviders.includes(authProviderId) && pendingModelId) {
      // Provider just connected -- select the model and close auth prompt
      setSelectedModel(pendingModelId);
      setAuthProviderId(null);
      setPendingModelId(null);
      setApiKeyInput("");
      setAuthError(null);
      setAuthOauthLoading(false);
      setAuthOauthInstructions(null);
      setModelSearch("");
      setShowModelPicker(false);
    }
  }, [connectedProviders, authProviderId, pendingModelId, setSelectedModel]);

  // All models grouped by provider (connected + unconnected), filtered by search
  const modelsByProvider = useMemo(() => {
    const query = modelSearch.toLowerCase().trim();
    const connected: Record<string, { providerName: string; models: ModelInfo[] }> = {};
    const unconnected: Record<string, { providerName: string; models: ModelInfo[] }> = {};

    for (const model of allModels) {
      // Filter out hidden models
      const modelKey = `${model.providerId}/${model.id}`;
      if (hiddenModels.has(modelKey)) continue;

      // Filter by search query (match model name, id, or provider name)
      if (query) {
        const haystack = `${model.name} ${model.id} ${model.providerName}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }

      const isConnected = connectedProviders.includes(model.providerId);
      const target = isConnected ? connected : unconnected;
      if (!target[model.providerId]) {
        target[model.providerId] = {
          providerName: model.providerName,
          models: [],
        };
      }
      target[model.providerId].models.push(model);
    }

    // Sort models within each group
    for (const group of Object.values(connected)) {
      group.models.sort((a, b) => a.name.localeCompare(b.name));
    }
    for (const group of Object.values(unconnected)) {
      group.models.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { connected, unconnected };
  }, [allModels, connectedProviders, hiddenModels, modelSearch]);

  // Visible agents: primary or all mode, not hidden
  const visibleAgents = useMemo(
    () => agents.filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all")),
    [agents],
  );

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const s = useStore.getState();
    if (s.isBusy || s.studioStatus !== "connected") return;
    s.sendMessage(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const s = useStore.getState();
      if (s.isBusy || s.studioStatus !== "connected") return;
      handleSubmit();
    }
  }

  function handleModelClick(model: ModelInfo) {
    const fullId = `${model.providerId}/${model.id}`;
    const isConnected = connectedProviders.includes(model.providerId);

    if (isConnected) {
      setSelectedModel(fullId);
      setShowModelPicker(false);
      setModelSearch("");
      setAuthProviderId(null);
    } else {
      // Show inline auth for this provider
      setAuthProviderId(model.providerId);
      setAuthProviderName(model.providerName);
      setPendingModelId(fullId);
      setApiKeyInput("");
      setAuthError(null);
    }
  }

  function getOAuthMethodIndex(providerId: string): number | null {
    const methods = authMethods[providerId];
    if (!methods) return null;
    const idx = methods.findIndex((m) => m.type === "oauth");
    return idx >= 0 ? idx : null;
  }

  function hasApiKeyAuth(providerId: string): boolean {
    const methods = authMethods[providerId];
    if (!methods || methods.length === 0) return true;
    return methods.some((m) => m.type === "api");
  }

  function resetInlineOAuth() {
    setAuthOauthLoading(false);
    setAuthOauthInstructions(null);
    setAuthOauthMethod(null);
    setAuthOauthCodeInput("");
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = null;
  }

  async function handleInlineOAuth() {
    if (!authProviderId) return;
    const methodIndex = getOAuthMethodIndex(authProviderId);
    if (methodIndex === null) return;

    setAuthOauthLoading(true);
    setAuthOauthInstructions(null);
    setAuthOauthMethod(null);
    setAuthOauthCodeInput("");
    setAuthError(null);
    try {
      const authResult = await useStore.getState().startOAuth(authProviderId, methodIndex);
      if (!authResult) {
        resetInlineOAuth();
        return;
      }
      setAuthOauthMethod(authResult.method);
      if (authResult.instructions) {
        setAuthOauthInstructions(authResult.instructions);
      }
      if (authResult.method === "auto") {
        // For "auto" flows (e.g. GitHub device code): call callback which blocks
        // until the user authorizes on the external site
        const abort = new AbortController();
        oauthAbortRef.current = abort;
        try {
          await useStore.getState().completeOAuth(authProviderId, methodIndex);
          if (!abort.signal.aborted) {
            resetInlineOAuth();
            // The useEffect watching connectedProviders will auto-select the model
          }
        } catch {
          if (!abort.signal.aborted) {
            setAuthError("Sign-in timed out or was cancelled");
            resetInlineOAuth();
          }
        }
      }
      // For "code" flows, we wait for the user to submit via handleInlineOAuthCode
    } catch {
      setAuthError("Failed to start sign-in");
      resetInlineOAuth();
    }
  }

  async function handleInlineOAuthCode() {
    if (!authProviderId || !authOauthCodeInput.trim()) return;
    const methodIndex = getOAuthMethodIndex(authProviderId);
    if (methodIndex === null) return;
    try {
      await useStore
        .getState()
        .completeOAuth(authProviderId, methodIndex, authOauthCodeInput.trim());
      resetInlineOAuth();
      // The useEffect watching connectedProviders will auto-select the model
    } catch {
      setAuthError("Invalid code. Please try again.");
      resetInlineOAuth();
    }
  }

  async function handleInlineApiKey() {
    if (!authProviderId || !apiKeyInput.trim()) return;
    setAuthSaving(true);
    setAuthError(null);
    try {
      await useStore.getState().setApiKey(authProviderId, apiKeyInput.trim());
      // The useEffect watching connectedProviders will auto-select the model
    } catch {
      setAuthError("Invalid key or connection failed");
    } finally {
      setAuthSaving(false);
    }
  }

  // Display labels
  const modelDisplay = selectedModel
    ? (selectedModel.split("/").pop() ?? selectedModel)
    : "Select model";

  const agentDisplay = selectedAgent ?? "Default agent";

  // Helper to render status badge
  function statusBadge(status?: string) {
    if (status === "beta") {
      return (
        <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700">
          beta
        </span>
      );
    }
    if (status === "alpha") {
      return (
        <span className="shrink-0 rounded bg-purple-100 px-1 text-[9px] font-medium text-purple-700">
          alpha
        </span>
      );
    }
    if (status === "deprecated") {
      return (
        <span className="shrink-0 rounded bg-stone-100 px-1 text-[9px] font-medium text-stone-500">
          deprecated
        </span>
      );
    }
    return null;
  }

  // Render a provider group of models
  function renderProviderGroup(
    providerId: string,
    group: { providerName: string; models: ModelInfo[] },
    isConnected: boolean,
  ) {
    return (
      <div key={providerId}>
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.providerName}
          </span>
          {!isConnected && (
            <span className="rounded bg-stone-100 px-1 text-[9px] text-stone-500">
              not connected
            </span>
          )}
        </div>
        {group.models.map((model) => {
          const fullId = `${model.providerId}/${model.id}`;
          const isSelected = selectedModel === fullId;
          return (
            <button
              key={model.id}
              onClick={() => handleModelClick(model)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : isConnected
                    ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                    : "text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground"
              }`}
            >
              {!isConnected && (
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-stone-400"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
              <span className="truncate">{model.name}</span>
              {statusBadge(model.status)}
            </button>
          );
        })}
      </div>
    );
  }

  const meta = authProviderId ? PROVIDER_META[authProviderId] : null;
  const oauthIndex = authProviderId ? getOAuthMethodIndex(authProviderId) : null;
  const showApiKey = authProviderId ? hasApiKeyAuth(authProviderId) : false;

  return (
    <div className="shrink-0 border-t bg-card px-4 py-3">
      {/* Toolbar row: model, agent, variant selectors */}
      <div className="relative mb-2 flex items-center gap-1">
        {/* Model selector */}
        <div className="relative" ref={modelPickerRef}>
          <button
            onClick={() => {
              setShowModelPicker(!showModelPicker);
              setShowAgentPicker(false);
              if (showModelPicker) {
                setAuthProviderId(null);
                setModelSearch("");
              }
            }}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
            {modelDisplay}
          </button>
          {showModelPicker && (
            <div className="absolute bottom-full left-0 z-50 mb-1 flex max-h-80 w-80 flex-col rounded-lg border bg-popover shadow-lg">
              {/* Inline auth prompt (replaces model list when active) */}
              {authProviderId ? (
                <div className="p-3">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        resetInlineOAuth();
                        setAuthProviderId(null);
                      }}
                      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="15 18 9 12 15 6" />
                      </svg>
                    </button>
                    <span className="text-xs font-medium">Connect {authProviderName}</span>
                  </div>

                  <div className="mt-3 space-y-2">
                    {/* OAuth button */}
                    {oauthIndex !== null && (
                      <div>
                        {authOauthLoading ? (
                          <div className="space-y-2">
                            <button
                              disabled
                              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border bg-background text-xs font-medium opacity-50"
                            >
                              <svg
                                className="h-3 w-3 animate-spin"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                              </svg>
                              Waiting for sign-in...
                            </button>
                            {authOauthInstructions && authOauthMethod === "auto" && (
                              <div className="rounded-md border bg-muted/50 p-2">
                                <p className="text-[11px] leading-relaxed text-muted-foreground">
                                  {authOauthInstructions}
                                </p>
                                <button
                                  onClick={() => {
                                    const code =
                                      authOauthInstructions.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/i);
                                    if (code) {
                                      navigator.clipboard.writeText(code[0]);
                                      toast("Code copied to clipboard");
                                    }
                                  }}
                                  className="mt-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-accent"
                                >
                                  <svg
                                    width="10"
                                    height="10"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>
                                  Copy code
                                </button>
                              </div>
                            )}
                            {authOauthMethod === "code" && (
                              <div className="space-y-1.5">
                                {authOauthInstructions && (
                                  <p className="text-[11px] text-muted-foreground">
                                    {authOauthInstructions}
                                  </p>
                                )}
                                <div className="flex gap-1.5">
                                  <input
                                    type="text"
                                    value={authOauthCodeInput}
                                    onChange={(e) => setAuthOauthCodeInput(e.target.value)}
                                    placeholder="Paste authorization code..."
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && authOauthCodeInput.trim()) {
                                        e.preventDefault();
                                        handleInlineOAuthCode();
                                      }
                                    }}
                                    className="h-7 flex-1 rounded border bg-background px-2 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                                    autoFocus
                                  />
                                  <button
                                    onClick={handleInlineOAuthCode}
                                    disabled={!authOauthCodeInput.trim()}
                                    className="h-7 rounded bg-foreground px-2.5 text-[11px] font-medium text-background transition-opacity disabled:opacity-40"
                                  >
                                    Submit
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={handleInlineOAuth}
                            className="flex h-8 w-full items-center justify-center gap-2 rounded-md border bg-background text-xs font-medium transition-colors hover:bg-accent"
                          >
                            <svg
                              width="11"
                              height="11"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                              <polyline points="10 17 15 12 10 7" />
                              <line x1="15" y1="12" x2="3" y2="12" />
                            </svg>
                            Sign in with {authProviderName}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Divider */}
                    {oauthIndex !== null && showApiKey && (
                      <div className="flex items-center gap-2">
                        <div className="h-px flex-1 bg-border" />
                        <span className="text-[10px] text-muted-foreground">or</span>
                        <div className="h-px flex-1 bg-border" />
                      </div>
                    )}

                    {/* API key input */}
                    {showApiKey && (
                      <div>
                        <div className="flex gap-1.5">
                          <input
                            type="password"
                            value={apiKeyInput}
                            onChange={(e) => {
                              setApiKeyInput(e.target.value);
                              setAuthError(null);
                            }}
                            placeholder={meta?.placeholder ?? "API key..."}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && apiKeyInput.trim() && !authSaving) {
                                e.preventDefault();
                                handleInlineApiKey();
                              }
                            }}
                            className="h-7 flex-1 rounded border bg-background px-2 font-mono text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                            autoFocus
                          />
                          <button
                            onClick={handleInlineApiKey}
                            disabled={authSaving || !apiKeyInput.trim()}
                            className="h-7 rounded bg-foreground px-2.5 text-[11px] font-medium text-background transition-opacity disabled:opacity-40"
                          >
                            {authSaving ? "..." : "Save"}
                          </button>
                        </div>
                        {meta?.helpUrl && (
                          <a
                            href={meta.helpUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-block text-[10px] text-muted-foreground underline hover:text-foreground"
                          >
                            Get an API key
                          </a>
                        )}
                      </div>
                    )}

                    {/* Error */}
                    {authError && <p className="text-[11px] text-destructive">{authError}</p>}
                  </div>
                </div>
              ) : (
                /* Search + model list */
                <>
                  {/* Sticky search input */}
                  <div className="shrink-0 border-b px-2 py-1.5">
                    <div className="flex items-center gap-1.5 rounded-md border bg-background px-2">
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-muted-foreground/50"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        ref={modelSearchRef}
                        type="text"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder="Search models..."
                        className="h-7 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/40 focus:outline-none"
                        autoFocus
                      />
                      {modelSearch && (
                        <button
                          onClick={() => {
                            setModelSearch("");
                            modelSearchRef.current?.focus();
                          }}
                          className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Scrollable model list */}
                  <div className="flex-1 overflow-y-auto p-1">
                    {/* Connected providers first */}
                    {Object.entries(modelsByProvider.connected).map(([id, group]) =>
                      renderProviderGroup(id, group, true),
                    )}

                    {/* Divider if both sections exist */}
                    {Object.keys(modelsByProvider.connected).length > 0 &&
                      Object.keys(modelsByProvider.unconnected).length > 0 && (
                        <div className="mx-2 my-1 h-px bg-border" />
                      )}

                    {/* Unconnected providers */}
                    {Object.entries(modelsByProvider.unconnected).map(([id, group]) =>
                      renderProviderGroup(id, group, false),
                    )}

                    {/* Empty states */}
                    {allModels.length === 0 && (
                      <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                        No models available
                      </div>
                    )}
                    {allModels.length > 0 &&
                      Object.keys(modelsByProvider.connected).length === 0 &&
                      Object.keys(modelsByProvider.unconnected).length === 0 && (
                        <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                          No models matching "{modelSearch}"
                        </div>
                      )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Agent selector -- only show if there are agents */}
        {visibleAgents.length > 1 && (
          <div className="relative" ref={agentPickerRef}>
            <button
              onClick={() => {
                setShowAgentPicker(!showAgentPicker);
                setShowModelPicker(false);
              }}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              {agentDisplay}
            </button>
            {showAgentPicker && (
              <div className="absolute bottom-full left-0 z-50 mb-1 max-h-48 w-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
                {visibleAgents.map((agent) => {
                  const isSelected = selectedAgent === agent.name;
                  return (
                    <button
                      key={agent.name}
                      onClick={() => {
                        setSelectedAgent(agent.name);
                        setShowAgentPicker(false);
                      }}
                      className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors ${
                        isSelected
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <span className="text-xs font-medium">{agent.name}</span>
                      {agent.description && (
                        <span className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
                          {agent.description}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Variant cycle button -- only show when model has variants */}
        {availableVariants.length > 0 && (
          <button
            onClick={() => {
              // Cycle: default -> variant[0] -> ... -> variant[N-1] -> default
              if (!selectedVariant) {
                setSelectedVariant(availableVariants[0]);
              } else {
                const idx = availableVariants.indexOf(selectedVariant);
                if (idx === -1 || idx === availableVariants.length - 1) {
                  setSelectedVariant(null);
                } else {
                  setSelectedVariant(availableVariants[idx + 1]);
                }
              }
            }}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] capitalize text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={`Click to cycle variant (${["default", ...availableVariants].join(" → ")})`}
          >
            {selectedVariant ?? "default"}
          </button>
        )}
      </div>

      {/* Input area */}
      <div className="flex items-end gap-2 rounded-xl border bg-background px-3 py-2 ring-ring/20 transition-shadow focus-within:ring-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want to build..."
          rows={1}
          className="max-h-40 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <SendButton text={text} onSend={handleSubmit} />
      </div>

      <StatusHint />
    </div>
  );
}

export default ChatInput;
