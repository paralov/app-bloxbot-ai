import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useCompleteOAuth, useStartOAuth } from "@/hooks/mutations/useOAuth";
import { useDisconnectProvider, useSetApiKey } from "@/hooks/mutations/useSetApiKey";
import {
  useAllModels,
  useAllProviders,
  useAuthMethods,
  useConnectedProviders,
} from "@/hooks/useProviders";
import { desktop } from "@/lib/desktop";
import { THEME_OPTIONS, type ThemePreference } from "@/lib/theme";
import { usePreferences } from "@/providers/PreferencesProvider";
import type { ModelInfo, ProviderInfo } from "@/types";
import type { UpdateInfo } from "@/types/desktop";

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
    url: "https://create.roblox.com/docs/studio/mcp",
    description: "Official Studio MCP server",
  },
];

type SettingsTab = "providers" | "models" | "appearance" | "about";

interface SettingsProps {
  onClose: () => void;
}

function Settings({ onClose }: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>("providers");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    desktop
      .getVersion()
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
            App
          </div>
          <button
            onClick={() => setTab("appearance")}
            className={`mx-1.5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
              tab === "appearance"
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
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
            Appearance
          </button>
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
          {tab === "appearance" && <AppearanceTab />}
          {tab === "about" && <AboutTab appVersion={appVersion} />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Providers Tab — matches OpenCode's two-section layout with connect dialog
// ═══════════════════════════════════════════════════════════════════════

type ConnectDialogState =
  | { step: "closed" }
  | { step: "methods"; provider: ProviderInfo }
  | {
      step: "oauth";
      provider: ProviderInfo;
      methodIndex: number;
      method: "auto" | "code" | null;
      instructions: string | null;
    }
  | { step: "apikey"; provider: ProviderInfo };

function ProvidersTab() {
  const allProviders = useAllProviders();
  const connectedProviders = useConnectedProviders();
  const authMethods = useAuthMethods();
  const setApiKeyMutation = useSetApiKey();
  const startOAuthMutation = useStartOAuth();
  const completeOAuthMutation = useCompleteOAuth();
  const disconnectMutation = useDisconnectProvider();

  const [dialog, setDialog] = useState<ConnectDialogState>({ step: "closed" });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const oauthAbortRef = useRef<AbortController | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closeDialog = useCallback(() => {
    oauthAbortRef.current?.abort();
    oauthAbortRef.current = null;
    setDialog({ step: "closed" });
    setApiKeyInput("");
    setOauthCodeInput("");
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      oauthAbortRef.current?.abort();
    };
  }, []);

  // Close dialog on click outside
  useEffect(() => {
    if (dialog.step === "closed") return;
    function handleClick(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        closeDialog();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dialog.step, closeDialog]);

  // Auto-close dialog when provider becomes connected
  const prevConnectedRef = useRef(connectedProviders);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = connectedProviders;
    if (dialog.step === "closed") return;
    const providerId = dialog.provider.id;
    if (connectedProviders.includes(providerId) && !prev.includes(providerId)) {
      toast.success(`${dialog.provider.name} connected`);
      closeDialog();
    }
  }, [connectedProviders, dialog, closeDialog]);

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

  function openConnect(provider: ProviderInfo) {
    const oauthIdx = getOAuthMethodIndex(provider.id);
    const apiKey = hasApiKeyAuth(provider.id);

    // If only one method, skip method selection
    if (oauthIdx !== null && !apiKey) {
      startOAuthFlow(provider, oauthIdx);
    } else if (oauthIdx === null && apiKey) {
      setDialog({ step: "apikey", provider });
    } else if (oauthIdx !== null && apiKey) {
      setDialog({ step: "methods", provider });
    } else {
      // No auth methods available
      setError(
        `No authentication methods available. Required env vars: ${provider.env.join(", ")}`,
      );
      setDialog({ step: "methods", provider });
    }
  }

  async function startOAuthFlow(provider: ProviderInfo, methodIndex: number) {
    setDialog({ step: "oauth", provider, methodIndex, method: null, instructions: null });
    setError(null);
    try {
      const authResult = await startOAuthMutation.mutateAsync({
        providerID: provider.id,
        methodIndex,
      });
      if (!authResult) {
        closeDialog();
        return;
      }
      setDialog({
        step: "oauth",
        provider,
        methodIndex,
        method: authResult.method,
        instructions: authResult.instructions ?? null,
      });
      if (authResult.method === "auto") {
        const abort = new AbortController();
        oauthAbortRef.current = abort;
        try {
          const success = await completeOAuthMutation.mutateAsync({
            providerID: provider.id,
            methodIndex,
          });
          if (!abort.signal.aborted) {
            if (success) {
              // Auto-close handled by the connectedProviders effect
            } else {
              setError("Authorization failed. Please try again.");
              setDialog({ step: "methods", provider });
            }
          }
        } catch {
          if (!abort.signal.aborted) {
            setError("Sign-in timed out or was cancelled");
            setDialog({ step: "methods", provider });
          }
        }
      }
    } catch {
      setError("Failed to start sign-in flow");
      setDialog({ step: "methods", provider });
    }
  }

  async function handleOAuthCode(providerId: string) {
    if (dialog.step !== "oauth" || !oauthCodeInput.trim()) return;
    try {
      const success = await completeOAuthMutation.mutateAsync({
        providerID: providerId,
        methodIndex: dialog.methodIndex,
        code: oauthCodeInput.trim(),
      });
      if (!success) {
        setError("Authorization failed. Please try again.");
      }
      // Success auto-closes via connectedProviders effect
    } catch {
      setError("Invalid code. Please try again.");
    }
    setOauthCodeInput("");
  }

  async function handleSaveKey(providerId: string) {
    if (!apiKeyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await setApiKeyMutation.mutateAsync({ providerID: providerId, key: apiKeyInput.trim() });
      // Success auto-closes via connectedProviders effect
    } catch {
      setError("Invalid key or connection failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect(providerId: string) {
    setDisconnecting(providerId);
    try {
      await disconnectMutation.mutateAsync(providerId);
      toast.success("Provider disconnected");
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(null);
    }
  }

  // Split providers into connected and unconnected
  const connected = allProviders.filter((p) => connectedProviders.includes(p.id));
  const unconnected = allProviders.filter((p) => !connectedProviders.includes(p.id));

  // Sort unconnected: popular first, then alphabetical
  const sortedUnconnected = useMemo(() => {
    const pop: ProviderInfo[] = [];
    const oth: ProviderInfo[] = [];
    for (const p of unconnected) {
      if (POPULAR_PROVIDERS.includes(p.id)) {
        pop.push(p);
      } else {
        oth.push(p);
      }
    }
    pop.sort((a, b) => POPULAR_PROVIDERS.indexOf(a.id) - POPULAR_PROVIDERS.indexOf(b.id));
    oth.sort((a, b) => a.name.localeCompare(b.name));
    return [...pop, ...oth];
  }, [unconnected]);

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">Providers</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Connect AI providers to use their models.
      </p>

      {/* Connected providers */}
      {connected.length > 0 && (
        <div className="mt-6">
          <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Connected
          </div>
          <div className="space-y-1.5">
            {connected.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border bg-card px-3.5 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Connected
                  </span>
                </div>
                {provider.id !== "opencode" && (
                  <button
                    onClick={() => handleDisconnect(provider.id)}
                    disabled={disconnecting === provider.id}
                    className="text-[11px] text-muted-foreground transition-colors hover:text-red-600 disabled:opacity-50"
                  >
                    {disconnecting === provider.id ? "..." : "Disconnect"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unconnected providers */}
      {sortedUnconnected.length > 0 && (
        <div className="mt-6">
          <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {connected.length > 0 ? "Available" : "Providers"}
          </div>
          <div className="space-y-1.5">
            {sortedUnconnected.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between rounded-lg border bg-card px-3.5 py-2.5"
              >
                <span className="text-sm font-medium">{provider.name}</span>
                <button
                  onClick={() => openConnect(provider)}
                  className="rounded-md border bg-background px-3 py-1 text-[11px] font-medium transition-colors hover:bg-accent"
                >
                  Connect
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {allProviders.length === 0 && (
        <div className="mt-8 py-4 text-center text-xs text-muted-foreground">
          Loading providers...
        </div>
      )}

      {/* Connect dialog overlay */}
      {dialog.step !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            ref={dialogRef}
            className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <h5 className="text-sm font-semibold">Connect {dialog.provider.name}</h5>
              <button
                onClick={closeDialog}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {error && <p className="mt-3 text-[11px] text-destructive">{error}</p>}

            {/* Method selection */}
            {dialog.step === "methods" && (
              <div className="mt-4 space-y-2">
                {getOAuthMethodIndex(dialog.provider.id) !== null && (
                  <button
                    onClick={() => {
                      const idx = getOAuthMethodIndex(dialog.provider.id);
                      if (idx !== null) {
                        setError(null);
                        startOAuthFlow(dialog.provider, idx);
                      }
                    }}
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
                    Sign in with {dialog.provider.name}
                  </button>
                )}
                {getOAuthMethodIndex(dialog.provider.id) !== null &&
                  hasApiKeyAuth(dialog.provider.id) && (
                    <div className="flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <span className="text-[10px] text-muted-foreground">or</span>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                  )}
                {hasApiKeyAuth(dialog.provider.id) && (
                  <button
                    onClick={() => {
                      setError(null);
                      setDialog({ step: "apikey", provider: dialog.provider });
                    }}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-background text-xs font-medium transition-colors hover:bg-accent"
                  >
                    Use an API key
                  </button>
                )}
              </div>
            )}

            {/* OAuth flow */}
            {dialog.step === "oauth" && (
              <div className="mt-4 space-y-3">
                {!dialog.method && (
                  <div className="flex items-center justify-center py-4">
                    <svg
                      className="h-4 w-4 animate-spin text-muted-foreground"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                    </svg>
                  </div>
                )}
                {dialog.method === "auto" && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
                      <svg
                        className="h-3 w-3 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                      </svg>
                      Waiting for authorization...
                    </div>
                    {dialog.instructions && (
                      <div className="rounded-md border bg-muted/50 p-2.5">
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {dialog.instructions}
                        </p>
                        <button
                          onClick={() => {
                            const code = dialog.instructions?.match(/[A-Z0-9]{4,}-[A-Z0-9]{4,}/i);
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
                  </div>
                )}
                {dialog.method === "code" && (
                  <div className="space-y-2">
                    {dialog.instructions && (
                      <p className="text-[11px] text-muted-foreground">{dialog.instructions}</p>
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
                            handleOAuthCode(dialog.provider.id);
                          }
                        }}
                        className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                        autoFocus
                      />
                      <button
                        onClick={() => handleOAuthCode(dialog.provider.id)}
                        disabled={!oauthCodeInput.trim()}
                        className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
                      >
                        Submit
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* API key input */}
            {dialog.step === "apikey" && (
              <div className="mt-4 space-y-2">
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value);
                      setError(null);
                    }}
                    placeholder={PROVIDER_META[dialog.provider.id]?.placeholder ?? "API key..."}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && apiKeyInput.trim() && !saving) {
                        e.preventDefault();
                        handleSaveKey(dialog.provider.id);
                      }
                    }}
                    className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <button
                    onClick={() => handleSaveKey(dialog.provider.id)}
                    disabled={saving || !apiKeyInput.trim()}
                    className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
                  >
                    {saving ? "..." : "Save"}
                  </button>
                </div>
                {PROVIDER_META[dialog.provider.id]?.helpUrl && (
                  <a
                    href={PROVIDER_META[dialog.provider.id]?.helpUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-[10px] text-muted-foreground underline hover:text-foreground"
                  >
                    Get an API key
                  </a>
                )}
                {getOAuthMethodIndex(dialog.provider.id) !== null && (
                  <button
                    onClick={() => setDialog({ step: "methods", provider: dialog.provider })}
                    className="block text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Back to sign-in options
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Models Tab
// ═══════════════════════════════════════════════════════════════════════

function ModelsTab() {
  const allModels = useAllModels();
  const connectedProviders = useConnectedProviders();
  const { hiddenModels, toggleModelVisibility } = usePreferences();

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
                  <div key={modelKey}>
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
// Appearance Tab
// ═══════════════════════════════════════════════════════════════════════

function AppearanceTab() {
  const { theme, setTheme } = usePreferences();

  return (
    <div className="mx-auto w-full max-w-md px-6 py-8">
      <h4 className="font-serif text-lg italic text-foreground">Appearance</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose how BloxBot looks. System follows your OS preference.
      </p>

      <div className="mt-6">
        <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Theme
        </div>
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map((option) => {
            const selected = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setTheme(option.value)}
                aria-pressed={selected}
                className={`rounded-lg border px-3 py-3 text-center transition-colors ${
                  selected
                    ? "border-foreground bg-accent font-medium text-foreground"
                    : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <ThemePreview swatch={option.value} />
                <span className="mt-2 block text-xs">{option.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThemePreview({ swatch }: { swatch: ThemePreference }) {
  if (swatch === "light") {
    return (
      <div className="mx-auto flex h-10 w-full max-w-[72px] overflow-hidden rounded-md border border-stone-200">
        <div className="w-1/3 bg-stone-100" />
        <div className="flex-1 bg-stone-50" />
      </div>
    );
  }
  if (swatch === "dark") {
    return (
      <div className="mx-auto flex h-10 w-full max-w-[72px] overflow-hidden rounded-md border border-stone-700">
        <div className="w-1/3 bg-stone-800" />
        <div className="flex-1 bg-stone-950" />
      </div>
    );
  }
  return (
    <div className="mx-auto flex h-10 w-full max-w-[72px] overflow-hidden rounded-md border border-border">
      <div className="w-1/2 bg-stone-50" />
      <div className="w-1/2 bg-stone-950" />
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
  const updateRef = useRef<UpdateInfo | null>(null);

  async function handleCheckForUpdates() {
    setUpdateStatus("checking");
    setUpdateError(null);
    setUpdateVersion(null);
    try {
      const update = await desktop.checkForUpdate();
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
      await desktop.installUpdate();
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
              <p className="rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
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
