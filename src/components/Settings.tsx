import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useStore } from "@/stores/opencode";
import type { ModelInfo, ProviderInfo } from "@/types";

// ── Popular providers (same order as OpenCode's web UI) ──────────────
const POPULAR_PROVIDERS = [
  "opencode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
];

// ── Provider-specific metadata for auth UX ───────────────────────────
const PROVIDER_META: Record<string, { placeholder?: string; helpUrl?: string }> = {
  opencode: {
    placeholder: "opencode-...",
    helpUrl: "https://opencode.ai/zen",
  },
  anthropic: {
    placeholder: "sk-ant-...",
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    placeholder: "sk-...",
    helpUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    placeholder: "AIza...",
    helpUrl: "https://aistudio.google.com/app/apikey",
  },
  openrouter: {
    placeholder: "sk-or-...",
    helpUrl: "https://openrouter.ai/keys",
  },
};

const TECHNOLOGIES = [
  { name: "OpenCode", url: "https://opencode.ai", description: "AI coding engine" },
  {
    name: "Roblox Studio MCP",
    url: "https://github.com/boshyxd/robloxstudio-mcp",
    description: "Studio bridge server",
  },
];

type SettingsTab = "providers" | "models" | "studio" | "about";

interface SettingsProps {
  onClose: () => void;
}

function Settings({ onClose }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>("providers");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center gap-3 border-b px-4">
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back to chat"
        >
          <svg
            width="14"
            height="14"
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
        <h3 className="text-xs font-semibold">Settings</h3>
      </div>

      {/* Body: sidebar + content */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        <div className="flex w-40 shrink-0 flex-col border-r py-3">
          <div className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Server
          </div>
          <button
            onClick={() => setTab("providers")}
            className={`mx-1.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              tab === "providers"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Providers
          </button>
          <button
            onClick={() => setTab("models")}
            className={`mx-1.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              tab === "models"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            Models
          </button>

          <div className="mt-4 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Integration
          </div>
          <button
            onClick={() => setTab("studio")}
            className={`mx-1.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              tab === "studio"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            Studio
          </button>

          <div className="mt-4 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            App
          </div>
          <button
            onClick={() => setTab("about")}
            className={`mx-1.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              tab === "about"
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            About
          </button>
        </div>

        {/* Content area */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {tab === "providers" && <ProvidersTab />}
          {tab === "models" && <ModelsTab />}
          {tab === "studio" && <StudioTab />}
          {tab === "about" && <AboutTab appVersion={appVersion} />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Providers Tab
// ═══════════════════════════════════════════════════════════════════════

function ProvidersTab() {
  const allProviders = useStore((s) => s.allProviders);
  const connectedProviders = useStore((s) => s.connectedProviders);
  const authMethods = useStore((s) => s.authMethods);
  const storeSetApiKey = useStore((s) => s.setApiKey);
  const storeStartOAuth = useStore((s) => s.startOAuth);
  const storeCompleteOAuth = useStore((s) => s.completeOAuth);
  const storeDisconnect = useStore((s) => s.disconnectProvider);

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [oauthInstructions, setOauthInstructions] = useState<string | null>(null);
  const [oauthMethod, setOauthMethod] = useState<"auto" | "code" | null>(null);
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<{
    providerId: string;
    type: "success" | "error";
    text: string;
  } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  /** Holds the AbortController for cancelling an in-flight completeOAuth call. */
  const oauthAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
    return () => {
      oauthAbortRef.current?.abort();
    };
  }, []);

  const { popular, other } = useMemo(() => {
    const query = search.toLowerCase().trim();
    const filtered = allProviders.filter((p) => {
      if (!query) return true;
      return `${p.name} ${p.id}`.toLowerCase().includes(query);
    });

    const pop: ProviderInfo[] = [];
    const oth: ProviderInfo[] = [];
    for (const p of filtered) {
      if (POPULAR_PROVIDERS.includes(p.id)) {
        pop.push(p);
      } else {
        oth.push(p);
      }
    }
    pop.sort((a, b) => POPULAR_PROVIDERS.indexOf(a.id) - POPULAR_PROVIDERS.indexOf(b.id));
    oth.sort((a, b) => a.name.localeCompare(b.name));
    return { popular: pop, other: oth };
  }, [allProviders, search]);

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

  function resetOAuthState() {
    setOauthLoading(null);
    setOauthInstructions(null);
    setOauthMethod(null);
    setOauthCodeInput("");
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = null;
  }

  async function handleOAuth(providerId: string) {
    const methodIndex = getOAuthMethodIndex(providerId);
    if (methodIndex === null) return;
    setOauthLoading(providerId);
    setOauthInstructions(null);
    setOauthMethod(null);
    setOauthCodeInput("");
    setFeedback(null);
    try {
      const authResult = await storeStartOAuth(providerId, methodIndex);
      if (!authResult) {
        resetOAuthState();
        return;
      }
      setOauthMethod(authResult.method);
      if (authResult.instructions) {
        setOauthInstructions(authResult.instructions);
      }
      if (authResult.method === "auto") {
        // For "auto" flows (e.g. GitHub device code): call callback which blocks
        // until the user authorizes on the external site
        const abort = new AbortController();
        oauthAbortRef.current = abort;
        try {
          await storeCompleteOAuth(providerId, methodIndex);
          if (!abort.signal.aborted) {
            resetOAuthState();
            setFeedback({ providerId, type: "success", text: "Connected!" });
          }
        } catch {
          if (!abort.signal.aborted) {
            setFeedback({
              providerId,
              type: "error",
              text: "Sign-in timed out or was cancelled",
            });
            resetOAuthState();
          }
        }
      }
      // For "code" flows, we wait for the user to submit a code via handleOAuthCode
    } catch {
      setFeedback({
        providerId,
        type: "error",
        text: "Failed to start sign-in flow",
      });
      resetOAuthState();
    }
  }

  async function handleOAuthCode(providerId: string) {
    const methodIndex = getOAuthMethodIndex(providerId);
    if (methodIndex === null || !oauthCodeInput.trim()) return;
    try {
      await storeCompleteOAuth(providerId, methodIndex, oauthCodeInput.trim());
      resetOAuthState();
      setFeedback({ providerId, type: "success", text: "Connected!" });
    } catch {
      setFeedback({
        providerId,
        type: "error",
        text: "Invalid code. Please try again.",
      });
      resetOAuthState();
    }
  }

  async function handleDisconnect(providerId: string) {
    setDisconnecting(providerId);
    setFeedback(null);
    try {
      await storeDisconnect(providerId);
      setExpandedProvider(null);
      setFeedback({ providerId, type: "success", text: "Disconnected" });
    } catch {
      setFeedback({
        providerId,
        type: "error",
        text: "Failed to disconnect",
      });
    } finally {
      setDisconnecting(null);
    }
  }

  async function handleSaveKey(providerId: string, label: string) {
    if (!apiKeyInput.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      await storeSetApiKey(providerId, apiKeyInput.trim());
      setApiKeyInput("");
      setExpandedProvider(null);
      setFeedback({ providerId, type: "success", text: `${label} connected` });
    } catch {
      setFeedback({
        providerId,
        type: "error",
        text: "Invalid key or connection failed",
      });
    } finally {
      setSaving(false);
    }
  }

  // Auto-collapse when a provider just became connected (e.g. after OAuth flow)
  const prevConnectedRef = useRef(connectedProviders);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = connectedProviders;
    if (!expandedProvider) return;
    // Only collapse if this provider wasn't connected before but is now
    const justConnected =
      connectedProviders.includes(expandedProvider) && !prev.includes(expandedProvider);
    if (justConnected) {
      setExpandedProvider(null);
      setApiKeyInput("");
    }
  }, [connectedProviders, expandedProvider]);

  function renderProvider(provider: ProviderInfo) {
    const meta = PROVIDER_META[provider.id];
    const isConnected = connectedProviders.includes(provider.id);
    const isExpanded = expandedProvider === provider.id;
    const oauthIndex = getOAuthMethodIndex(provider.id);
    const supportsApiKey = hasApiKeyAuth(provider.id);
    const isOauthLoading = oauthLoading === provider.id;
    const providerFeedback = feedback?.providerId === provider.id ? feedback : null;

    return (
      <div key={provider.id} className="rounded-lg border bg-card">
        <button
          onClick={() => {
            setExpandedProvider(isExpanded ? null : provider.id);
            setApiKeyInput("");
            setFeedback(null);
          }}
          className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-semibold text-muted-foreground">
            {provider.name.charAt(0).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">{provider.name}</span>
            {provider.id === "opencode" && (
              <span className="shrink-0 rounded bg-sky-50 px-1.5 py-px text-[9px] font-medium text-sky-700">
                Recommended
              </span>
            )}
          </div>
          {isConnected && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Connected
            </span>
          )}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Connected: show disconnect option */}
        {isExpanded && isConnected && (
          <div className="animate-fade-in border-t px-3.5 py-3">
            <button
              onClick={() => handleDisconnect(provider.id)}
              disabled={disconnecting === provider.id}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-red-200 bg-background text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              {disconnecting === provider.id ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                  Disconnecting...
                </>
              ) : (
                "Disconnect"
              )}
            </button>
            {providerFeedback && (
              <p
                className={`mt-2 text-[11px] ${providerFeedback.type === "error" ? "text-destructive" : "text-emerald-600"}`}
              >
                {providerFeedback.text}
              </p>
            )}
          </div>
        )}

        {/* Not connected: show sign-in options */}
        {isExpanded && !isConnected && (
          <div className="animate-fade-in border-t px-3.5 py-3">
            {oauthIndex !== null && (
              <div>
                {isOauthLoading ? (
                  <div className="space-y-2">
                    <button
                      disabled
                      className="flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background text-xs font-medium opacity-50"
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
                    {oauthInstructions && oauthMethod === "auto" && (
                      <div className="rounded-md border bg-muted/50 p-2.5">
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {oauthInstructions}
                        </p>
                        <button
                          onClick={() => {
                            const code = oauthInstructions.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/i);
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
                    {oauthMethod === "code" && (
                      <div className="space-y-1.5">
                        {oauthInstructions && (
                          <p className="text-[11px] text-muted-foreground">{oauthInstructions}</p>
                        )}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={oauthCodeInput}
                            onChange={(e) => setOauthCodeInput(e.target.value)}
                            placeholder="Paste authorization code..."
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && oauthCodeInput.trim()) {
                                e.preventDefault();
                                handleOAuthCode(provider.id);
                              }
                            }}
                            className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                            autoFocus
                          />
                          <button
                            onClick={() => handleOAuthCode(provider.id)}
                            disabled={!oauthCodeInput.trim()}
                            className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
                          >
                            Submit
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => handleOAuth(provider.id)}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background text-xs font-medium transition-colors hover:bg-accent"
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
                      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                      <polyline points="10 17 15 12 10 7" />
                      <line x1="15" y1="12" x2="3" y2="12" />
                    </svg>
                    Sign in with {provider.name}
                  </button>
                )}
              </div>
            )}
            {oauthIndex !== null && supportsApiKey && (
              <div className="my-2.5 flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[10px] text-muted-foreground">or use an API key</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            {supportsApiKey && (
              <>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      setFeedback(null);
                    }}
                    placeholder={meta?.placeholder ?? "API key..."}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && apiKeyInput.trim() && !saving) {
                        e.preventDefault();
                        handleSaveKey(provider.id, provider.name);
                      }
                    }}
                    className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus={oauthIndex === null}
                  />
                  <button
                    onClick={() => handleSaveKey(provider.id, provider.name)}
                    disabled={saving || !apiKeyInput.trim()}
                    className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
                  >
                    {saving ? "..." : "Save"}
                  </button>
                </div>
                {meta?.helpUrl && (
                  <a
                    href={meta.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-[10px] text-muted-foreground underline hover:text-foreground"
                  >
                    Get an API key
                  </a>
                )}
              </>
            )}
            {oauthIndex === null && !supportsApiKey && (
              <p className="text-[11px] text-muted-foreground">
                No authentication methods available. Required env vars: {provider.env.join(", ")}
              </p>
            )}
            {providerFeedback && (
              <p
                className={`mt-2 text-[11px] ${providerFeedback.type === "error" ? "text-destructive" : "text-emerald-600"}`}
              >
                {providerFeedback.text}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderGroup(label: string, providers: ProviderInfo[]) {
    if (providers.length === 0) return null;
    return (
      <div>
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="space-y-1.5">{providers.map((p) => renderProvider(p))}</div>
      </div>
    );
  }

  const hasResults = popular.length > 0 || other.length > 0;

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">Providers</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect AI providers to use their models. Keys are stored locally.
      </p>

      {/* Search */}
      <div className="mt-4">
        <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5">
          <svg
            width="13"
            height="13"
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
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search providers..."
            className="h-8 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/40 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
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

      <div className="mt-4 space-y-5">
        {renderGroup("Popular", popular)}
        {renderGroup("Other", other)}
        {!hasResults && allProviders.length > 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            No providers matching &quot;{search}&quot;
          </div>
        )}
        {allProviders.length === 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">Loading providers...</div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Models Tab
// ═══════════════════════════════════════════════════════════════════════

function ModelsTab() {
  const allModels = useStore((s) => s.allModels);
  const connectedProviders = useStore((s) => s.connectedProviders);
  const hiddenModels = useStore((s) => s.hiddenModels);
  const toggleModelVisibility = useStore((s) => s.toggleModelVisibility);

  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Group models by provider (only connected providers), filtered by search
  const modelsByProvider = useMemo(() => {
    const query = search.toLowerCase().trim();
    const groups: Record<string, { providerName: string; models: ModelInfo[] }> = {};

    for (const model of allModels) {
      // Only show models from connected providers
      if (!connectedProviders.includes(model.providerId)) continue;

      // Filter by search
      if (query) {
        const haystack = `${model.name} ${model.id} ${model.providerName}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }

      if (!groups[model.providerId]) {
        groups[model.providerId] = {
          providerName: model.providerName,
          models: [],
        };
      }
      groups[model.providerId].models.push(model);
    }

    // Sort models within each group
    for (const group of Object.values(groups)) {
      group.models.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Sort provider groups: popular first, then alphabetical
    const entries = Object.entries(groups);
    entries.sort(([aId], [bId]) => {
      const aPopular = POPULAR_PROVIDERS.includes(aId);
      const bPopular = POPULAR_PROVIDERS.includes(bId);
      if (aPopular && !bPopular) return -1;
      if (!aPopular && bPopular) return 1;
      if (aPopular && bPopular) {
        return POPULAR_PROVIDERS.indexOf(aId) - POPULAR_PROVIDERS.indexOf(bId);
      }
      return groups[aId].providerName.localeCompare(groups[bId].providerName);
    });

    return entries;
  }, [allModels, connectedProviders, search]);

  const totalModels = allModels.filter((m) => connectedProviders.includes(m.providerId)).length;

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">Models</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Toggle which models appear in the model selector.
      </p>

      {/* Search */}
      <div className="mt-4">
        <div className="flex items-center gap-1.5 rounded-lg border bg-background px-2.5">
          <svg
            width="13"
            height="13"
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
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            className="h-8 flex-1 bg-transparent text-xs placeholder:text-muted-foreground/40 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => {
                setSearch("");
                searchRef.current?.focus();
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

      {/* Model groups */}
      <div className="mt-5 space-y-6">
        {modelsByProvider.map(([providerId, group]) => (
          <div key={providerId}>
            <div className="flex items-center gap-2 pb-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent text-[10px] font-semibold text-muted-foreground">
                {group.providerName.charAt(0).toUpperCase()}
              </span>
              <span className="text-sm font-medium">{group.providerName}</span>
            </div>
            <div className="rounded-lg border bg-card">
              {group.models.map((model, idx) => {
                const modelKey = `${model.providerId}/${model.id}`;
                const isVisible = !hiddenModels.has(modelKey);
                return (
                  <div key={model.id}>
                    {idx > 0 && <div className="mx-3.5 h-px bg-border" />}
                    <button
                      onClick={() => toggleModelVisibility(modelKey)}
                      className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
                    >
                      <span className="truncate text-xs">{model.name}</span>
                      {/* Toggle switch */}
                      <span
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                          isVisible ? "bg-foreground" : "bg-border"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform ${
                            isVisible ? "translate-x-4" : "translate-x-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {modelsByProvider.length === 0 && totalModels > 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            No models matching &quot;{search}&quot;
          </div>
        )}

        {totalModels === 0 && (
          <div className="py-4 text-center text-xs text-muted-foreground">
            Connect a provider to see available models.
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Studio Tab
// ═══════════════════════════════════════════════════════════════════════

function StudioTab() {
  const studioStatus = useStore((s) => s.studioStatus);
  const studioError = useStore((s) => s.studioError);
  const mcpUrl = useStore((s) => s.mcpUrl);
  const restartMcpServer = useStore((s) => s.restartMcpServer);
  const pluginInstalled = useStore((s) => s.pluginInstalled);
  const installPlugin = useStore((s) => s.installPlugin);

  const [restarting, setRestarting] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(copyTimerRef.current), []);

  async function handleCopyUrl() {
    if (!mcpUrl) return;
    await navigator.clipboard.writeText(mcpUrl);
    setCopied(true);
    clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
  }

  async function handleRestart() {
    setRestarting(true);
    try {
      await restartMcpServer();
    } catch {
      // Error logged by store
    } finally {
      setRestarting(false);
    }
  }

  async function handleInstall() {
    setInstalling(true);
    try {
      await installPlugin();
    } catch {
      // Error logged by store
    } finally {
      setInstalling(false);
    }
  }

  const statusConfig: Record<string, { dot: string; label: string }> = {
    connected: { dot: "bg-emerald-400", label: "Connected" },
    disconnected: { dot: "bg-red-400", label: "Studio not connected" },
    failed: { dot: "bg-red-400", label: "MCP server unreachable" },
    disabled: { dot: "bg-stone-300", label: "Disabled" },
    needs_auth: { dot: "bg-amber-400", label: "MCP needs authentication" },
    unknown: { dot: "bg-stone-300 animate-pulse", label: "Checking..." },
  };
  const config = statusConfig[studioStatus] ?? statusConfig.unknown;

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">Roblox Studio</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Manage the MCP bridge that connects BloxBot to Roblox Studio.
      </p>

      {/* Connection status */}
      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Connection Status
        </div>
        <div className="rounded-lg border bg-card p-3.5">
          <div className="flex items-center gap-2.5">
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${config.dot}`} />
            <span className="text-sm font-medium">{config.label}</span>
          </div>
          {studioError && (
            <p className="mt-2 rounded bg-red-50 px-2 py-1 font-mono text-[10px] text-red-600">
              {studioError}
            </p>
          )}
          {studioStatus === "disconnected" && (
            <div className="mt-2.5">
              {pluginInstalled === false ? (
                <p className="text-[11px] text-muted-foreground">
                  The Studio plugin is not installed. Install it below, then open Roblox Studio and
                  connect from the Plugins tab.
                </p>
              ) : (
                <ol className="space-y-0.5 text-[11px] text-muted-foreground">
                  <li>1. Open Roblox Studio</li>
                  <li>2. Open or create a place file</li>
                  <li>
                    3. Click the <strong>Plugins</strong> tab and open the MCP plugin
                  </li>
                  <li>
                    4. Paste the connection URL and click <strong>Connect</strong>
                  </li>
                </ol>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Connection URL */}
      {mcpUrl && (
        <div className="mt-6">
          <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Connection URL
          </div>
          <div className="rounded-lg border bg-card p-3.5">
            <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
              Copy this URL into the Roblox Studio MCP plugin to connect.
            </p>
            <button
              onClick={handleCopyUrl}
              className="flex w-full items-center gap-2 rounded border bg-background px-3 py-2 text-left transition-colors hover:bg-accent"
            >
              <span className="flex-1 truncate font-mono text-xs">{mcpUrl}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {copied ? "Copied!" : "Click to copy"}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Actions
        </div>
        <div className="space-y-2">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border bg-card text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {restarting ? (
              <>
                <svg
                  className="h-3 w-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
                Restarting MCP Server...
              </>
            ) : (
              <>
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
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Restart MCP Server
              </>
            )}
          </button>

          {pluginInstalled === false && (
            <button
              onClick={handleInstall}
              disabled={installing}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border bg-card text-xs font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              {installing ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                  Installing Plugin...
                </>
              ) : (
                <>
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
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Install Studio Plugin
                </>
              )}
            </button>
          )}

          {pluginInstalled === true && (
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3.5 py-2.5">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-emerald-500"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span className="text-xs text-muted-foreground">Studio plugin installed</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// About Tab
// ═══════════════════════════════════════════════════════════════════════

type UpdateCheckStatus = "idle" | "checking" | "available" | "downloading" | "up-to-date" | "error";

function AboutTab({ appVersion }: { appVersion: string | null }) {
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckStatus>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Hold on to the Update handle so we can download it later
  const updateRef = useRef<Awaited<ReturnType<typeof check>> | null>(null);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    setUpdateError(null);
    setUpdateVersion(null);
    try {
      const update = await check();
      if (!update) {
        setUpdateStatus("up-to-date");
        return;
      }
      updateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateStatus("available");
    } catch (err) {
      console.error("[about] Failed to check for updates:", err);
      setUpdateError(err instanceof Error ? err.message : "Could not reach update server");
      setUpdateStatus("error");
    }
  }

  async function handleInstall() {
    const update = updateRef.current;
    if (!update) return;
    try {
      setUpdateStatus("downloading");
      await update.downloadAndInstall();
      await relaunch();
    } catch (err) {
      console.error("[about] Failed to install update:", err);
      setUpdateError(err instanceof Error ? err.message : "Installation failed");
      setUpdateStatus("error");
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">About BloxBot</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        AI-assisted Roblox development, right from your desktop.
      </p>

      {/* Version & update check */}
      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Version
        </div>
        <div className="rounded-lg border bg-card p-3.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm font-medium">
                BloxBot{appVersion && <span className="font-mono"> v{appVersion}</span>}
              </span>
            </div>
            {updateStatus === "idle" && (
              <button
                onClick={handleCheckForUpdates}
                className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
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
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Check for updates
              </button>
            )}
            {updateStatus === "checking" && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <svg
                  className="h-3 w-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
                Checking...
              </span>
            )}
            {updateStatus === "up-to-date" && (
              <span className="flex items-center gap-1.5 text-[11px] text-emerald-600">
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
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Up to date
              </span>
            )}
            {updateStatus === "downloading" && (
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <svg
                  className="h-3 w-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                </svg>
                Installing...
              </span>
            )}
          </div>

          {/* Update available */}
          {updateStatus === "available" && updateVersion && (
            <div className="mt-3 flex items-center justify-between rounded-md border bg-background px-3 py-2">
              <span className="text-xs">
                <span className="font-medium">v{updateVersion}</span>{" "}
                <span className="text-muted-foreground">is available</span>
              </span>
              <button
                onClick={handleInstall}
                className="rounded-md bg-foreground px-3 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
              >
                Install & Restart
              </button>
            </div>
          )}

          {/* Error */}
          {updateStatus === "error" && updateError && (
            <div className="mt-3">
              <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-600">
                {updateError}
              </p>
              <button
                onClick={handleCheckForUpdates}
                className="mt-2 text-[11px] text-muted-foreground underline hover:text-foreground"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Built with */}
      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Built With
        </div>
        <div className="rounded-lg border bg-card">
          {TECHNOLOGIES.map((tech, idx) => (
            <div key={tech.name}>
              {idx > 0 && <div className="mx-3.5 h-px bg-border" />}
              <a
                href={tech.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between px-3.5 py-2.5 transition-colors hover:bg-accent"
              >
                <div className="min-w-0">
                  <span className="text-xs font-medium">{tech.name}</span>
                  <span className="ml-2 text-[11px] text-muted-foreground">{tech.description}</span>
                </div>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0 text-muted-foreground"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
            </div>
          ))}
        </div>
        <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted-foreground">
          BloxBot is powered by these projects. Thank you to the teams behind them.
        </p>
      </div>

      {/* Links */}
      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Links
        </div>
        <div className="space-y-1.5">
          <a
            href="https://bloxbot.ai"
            target="_blank"
            rel="noreferrer"
            className="flex h-9 w-full items-center gap-2 rounded-lg border bg-card px-3.5 text-xs transition-colors hover:bg-accent"
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
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            Website
          </a>
          <a
            href="https://github.com/paralov/app-bloxbot-ai"
            target="_blank"
            rel="noreferrer"
            className="flex h-9 w-full items-center gap-2 rounded-lg border bg-card px-3.5 text-xs transition-colors hover:bg-accent"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </div>
  );
}

export default Settings;
