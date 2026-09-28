import { Check, ChevronLeft, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ProviderLogo from "@/components/ProviderLogo";
import {
  captureProviderConnectFailure,
  useCompleteOAuth,
  useStartOAuth,
} from "@/hooks/mutations/useOAuth";
import { useSetApiKey } from "@/hooks/mutations/useSetApiKey";
import { useAuthMethods, useConnectedProviders } from "@/hooks/useProviders";
import { desktop } from "@/lib/desktop";
import { OPENCODE_GO } from "@/lib/opencodeGo";
import {
  type AuthMethodOption,
  authErrorMessage,
  authMethodOptions,
  deviceCode,
  initialPromptInputs,
  oauthRecovery,
  submittedPromptInputs,
  visiblePrompts,
} from "@/lib/providerAuth";
import type { ProviderInfo } from "@/types";

// ── Provider-specific metadata for API key entry ─────────────────────
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
  [OPENCODE_GO.providerId]: {
    helpUrl: OPENCODE_GO.consoleUrl,
  },
};

interface ConnectError {
  message: string;
  hint?: string;
  /** Highlights the method most likely to work after this failure. */
  suggestedIndex?: number;
}

type Step =
  | { step: "methods" }
  | { step: "prompts"; option: AuthMethodOption; inputs: Record<string, string> }
  | {
      step: "oauth";
      option: AuthMethodOption;
      method: "auto" | "code" | null;
      instructions: string | null;
      url: string | null;
    }
  | { step: "apikey"; option: AuthMethodOption };

interface ProviderConnectDialogProps {
  provider: ProviderInfo;
  onClose: () => void;
  /** Called once the provider is connected, or its credential replaced. */
  onConnected: (provider: ProviderInfo) => void;
}

function ProviderConnectDialog({ provider, onClose, onConnected }: ProviderConnectDialogProps) {
  const authMethods = useAuthMethods();
  const connectedProviders = useConnectedProviders();
  const startOAuthMutation = useStartOAuth();
  const completeOAuthMutation = useCompleteOAuth();
  const setApiKeyMutation = useSetApiKey();

  const options = authMethodOptions(provider.id, authMethods[provider.id]);
  const [state, setState] = useState<Step>({ step: "methods" });
  const [error, setError] = useState<ConnectError | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [oauthCodeInput, setOauthCodeInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // Bumped whenever the user leaves a sign-in (back, another method, close), so
  // a request that finishes afterwards knows its flow was abandoned.
  const oauthFlowRef = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  const cancelPendingOAuth = useCallback(() => {
    oauthFlowRef.current += 1;
  }, []);

  const close = useCallback(() => {
    cancelPendingOAuth();
    onClose();
  }, [cancelPendingOAuth, onClose]);

  useEffect(() => cancelPendingOAuth, [cancelPendingOAuth]);

  const finish = useCallback(() => {
    onConnected(provider);
    close();
  }, [onConnected, provider, close]);

  // Close once the provider shows up as connected, whichever method got it there.
  const wasConnectedRef = useRef(connectedProviders.includes(provider.id));
  const alreadyConnected = useRef(wasConnectedRef.current).current;
  useEffect(() => {
    const isConnected = connectedProviders.includes(provider.id);
    if (isConnected && !wasConnectedRef.current) finish();
    wasConnectedRef.current = isConnected;
  }, [connectedProviders, provider, finish]);

  // Covers starting, waiting for approval, and waiting for a pasted code.
  const signInInProgress = state.step === "oauth";

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // A stray click must not throw away a sign-in the user is halfway through.
    function handleClick(e: MouseEvent) {
      if (signInInProgress) return;
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [close, signInInProgress]);

  function backToMethods(nextError: ConnectError | null = null) {
    cancelPendingOAuth();
    setError(nextError);
    setOauthCodeInput("");
    setState({ step: "methods" });
  }

  function choose(option: AuthMethodOption) {
    setError(null);
    if (option.type === "api") {
      setState({ step: "apikey", option });
    } else if (option.prompts.length > 0) {
      setState({ step: "prompts", option, inputs: initialPromptInputs(option.prompts) });
    } else {
      startOAuthFlow(option, {});
    }
  }

  async function startOAuthFlow(option: AuthMethodOption, inputs: Record<string, string>) {
    cancelPendingOAuth();
    const flow = oauthFlowRef.current;
    const abandoned = () => oauthFlowRef.current !== flow;
    setError(null);
    setState({ step: "oauth", option, method: null, instructions: null, url: null });

    let authResult: Awaited<ReturnType<typeof startOAuthMutation.mutateAsync>>;
    try {
      authResult = await startOAuthMutation.mutateAsync({
        providerID: provider.id,
        methodIndex: option.index,
        inputs: submittedPromptInputs(option.prompts, inputs),
      });
    } catch (err) {
      if (abandoned()) return;
      captureProviderConnectFailure(provider.id, "oauth_start", err, option.label);
      backToMethods({
        message: authErrorMessage(err) ?? `Couldn't start “${option.title}”.`,
        ...oauthRecovery(provider.id, option, options),
      });
      return;
    }
    if (abandoned()) return;
    if (!authResult) {
      backToMethods({ message: `Couldn't start “${option.title}”.` });
      return;
    }
    // OpenCode can't open a browser itself, so open the sign-in page here, and
    // only for a flow the user is still in.
    if (authResult.url) desktop.openUrl(authResult.url).catch(() => {});

    setState({
      step: "oauth",
      option,
      method: authResult.method,
      instructions: authResult.instructions ?? null,
      url: authResult.url ?? null,
    });
    if (authResult.method !== "auto") return;

    try {
      const success = await completeOAuthMutation.mutateAsync({
        providerID: provider.id,
        methodIndex: option.index,
      });
      if (abandoned()) return;
      if (!success) {
        captureProviderConnectFailure(provider.id, "oauth_complete", "rejected", option.label);
        backToMethods({
          message: `${provider.name} didn't accept the sign-in.`,
          ...oauthRecovery(provider.id, option, options),
        });
      } else if (alreadyConnected) {
        // A new connection closes through the connected-providers effect; a
        // replaced credential never changes that list, so finish here.
        finish();
      }
    } catch (err) {
      if (abandoned()) return;
      captureProviderConnectFailure(provider.id, "oauth_complete", err, option.label);
      backToMethods({
        message: authErrorMessage(err) ?? "Sign-in timed out or was cancelled.",
        ...oauthRecovery(provider.id, option, options),
      });
    }
  }

  async function submitOAuthCode() {
    if (state.step !== "oauth" || !oauthCodeInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const success = await completeOAuthMutation.mutateAsync({
        providerID: provider.id,
        methodIndex: state.option.index,
        code: oauthCodeInput.trim(),
      });
      if (!success) {
        captureProviderConnectFailure(
          provider.id,
          "oauth_complete",
          "rejected",
          state.option.label,
        );
        setError({ message: "That code didn't work. Copy it again and paste the whole code." });
      } else if (alreadyConnected) {
        finish();
      }
    } catch (err) {
      captureProviderConnectFailure(provider.id, "oauth_complete", err, state.option.label);
      setError({
        message: authErrorMessage(err) ?? "That code didn't work.",
        hint: "Codes expire quickly. Start the sign-in again to get a new one.",
      });
    } finally {
      setSaving(false);
      setOauthCodeInput("");
    }
  }

  async function saveApiKey() {
    if (!apiKeyInput.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await setApiKeyMutation.mutateAsync({ providerID: provider.id, key: apiKeyInput.trim() });
      if (alreadyConnected) finish();
    } catch (err) {
      captureProviderConnectFailure(provider.id, "api_key", err);
      setError({ message: authErrorMessage(err) ?? "Couldn't save the API key. Try again." });
    } finally {
      setSaving(false);
    }
  }

  async function copyDeviceCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Skip the chooser when there is only one way in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once when the dialog opens
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (options.length === 1) choose(options[0]);
  }, []);

  const meta = PROVIDER_META[provider.id];
  const canGoBack = options.length > 1 && state.step !== "methods";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-connect-title"
        className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            {canGoBack && (
              <button
                onClick={() => backToMethods()}
                className="-ml-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Back to ways to connect"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <ProviderLogo providerId={provider.id} name={provider.name} className="mr-1.5" />
            <h5 id="provider-connect-title" className="truncate text-sm font-semibold">
              Connect {provider.name}
            </h5>
          </div>
          <button
            onClick={close}
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
          >
            <p className="text-[11px] font-medium text-destructive">{error.message}</p>
            {error.hint && (
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                {error.hint}
              </p>
            )}
          </div>
        )}

        {state.step === "methods" && (
          <div className="mt-4 space-y-1.5">
            {options.map((option) => (
              <button
                key={option.index}
                onClick={() => choose(option)}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                  option.index === (error?.suggestedIndex ?? options[0].index)
                    ? "bg-accent/60 hover:bg-accent"
                    : "bg-background hover:bg-accent"
                }`}
              >
                <div className="text-xs font-medium">{option.title}</div>
                {option.description && (
                  <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    {option.description}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {state.step === "prompts" && (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              startOAuthFlow(state.option, state.inputs);
            }}
          >
            {visiblePrompts(state.option.prompts, state.inputs).map((prompt) => (
              <div key={prompt.key} className="space-y-1">
                <label
                  htmlFor={`auth-prompt-${prompt.key}`}
                  className="block text-[11px] text-muted-foreground"
                >
                  {prompt.message}
                </label>
                {prompt.type === "select" ? (
                  <select
                    id={`auth-prompt-${prompt.key}`}
                    value={state.inputs[prompt.key] ?? ""}
                    onChange={(e) =>
                      setState({
                        ...state,
                        inputs: { ...state.inputs, [prompt.key]: e.target.value },
                      })
                    }
                    className="h-8 w-full rounded border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {prompt.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.hint ? `${opt.label} (${opt.hint})` : opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`auth-prompt-${prompt.key}`}
                    type="text"
                    value={state.inputs[prompt.key] ?? ""}
                    placeholder={prompt.placeholder}
                    required
                    onChange={(e) =>
                      setState({
                        ...state,
                        inputs: { ...state.inputs, [prompt.key]: e.target.value },
                      })
                    }
                    className="h-8 w-full rounded border bg-background px-2 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                )}
              </div>
            ))}
            <button
              type="submit"
              className="h-8 w-full rounded bg-foreground text-xs font-medium text-background"
            >
              Continue
            </button>
          </form>
        )}

        {state.step === "oauth" && (
          <div className="mt-4 space-y-3">
            {!state.method && (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting sign-in…
              </div>
            )}

            {state.method === "auto" &&
              (deviceCode(state.instructions) ? (
                <DeviceCodeStep
                  code={deviceCode(state.instructions) ?? ""}
                  url={state.url}
                  copied={copied}
                  onCopy={copyDeviceCode}
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Finish signing in in your browser. This window updates when you're done.
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Waiting for {provider.name}…
                  </div>
                  {state.url && <ReopenLink url={state.url} label="Open the sign-in page again" />}
                </div>
              ))}

            {state.method === "code" && (
              <div className="space-y-2">
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {state.instructions ||
                    "Sign in in your browser, then paste the code it gives you."}
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={oauthCodeInput}
                    onChange={(e) => setOauthCodeInput(e.target.value)}
                    placeholder="Paste authorization code..."
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && oauthCodeInput.trim() && !saving) {
                        e.preventDefault();
                        submitOAuthCode();
                      }
                    }}
                    className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                    autoFocus
                  />
                  <button
                    onClick={submitOAuthCode}
                    disabled={saving || !oauthCodeInput.trim()}
                    className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
                  >
                    {saving ? "..." : "Submit"}
                  </button>
                </div>
                {state.url && <ReopenLink url={state.url} label="Open the sign-in page again" />}
              </div>
            )}

            {options.length > 1 && state.method && (
              <button
                onClick={() => backToMethods()}
                className="block text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Stuck? Use a different way to connect
              </button>
            )}
          </div>
        )}

        {state.step === "apikey" && (
          <div className="mt-4 space-y-2">
            {provider.id === OPENCODE_GO.providerId && <OpenCodeGoSetup />}
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => {
                  setApiKeyInput(e.target.value);
                  setError(null);
                }}
                placeholder={meta?.placeholder ?? "API key..."}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && apiKeyInput.trim() && !saving) {
                    e.preventDefault();
                    saveApiKey();
                  }
                }}
                className="h-8 flex-1 rounded border bg-background px-2 font-mono text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
              <button
                onClick={saveApiKey}
                disabled={saving || !apiKeyInput.trim()}
                className="h-8 rounded bg-foreground px-3 text-xs font-medium text-background transition-opacity disabled:opacity-40"
              >
                {saving ? "..." : "Save"}
              </button>
            </div>
            {meta?.helpUrl && provider.id !== OPENCODE_GO.providerId && (
              <a
                href={meta.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block text-[10px] text-muted-foreground underline hover:text-foreground"
              >
                Get an API key
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OpenCodeGoSetup() {
  return (
    <ol className="mb-3 space-y-2 text-[11px] leading-relaxed text-muted-foreground">
      <li className="flex gap-2">
        <span className="font-medium text-foreground">1.</span>
        <span>
          Subscribe to Go ({OPENCODE_GO.goPrice}) or Go Plus ({OPENCODE_GO.goPlusPrice}, higher
          limits) in the OpenCode console.{" "}
          <button
            onClick={() => {
              desktop.openUrl(OPENCODE_GO.consoleUrl).catch(() => {});
            }}
            className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-2 hover:underline"
          >
            Open the console
            <ExternalLink className="h-3 w-3" />
          </button>
        </span>
      </li>
      <li className="flex gap-2">
        <span className="font-medium text-foreground">2.</span>
        <span>Copy your API key from the console.</span>
      </li>
      <li className="flex gap-2">
        <span className="font-medium text-foreground">3.</span>
        <span>Paste it here. Both plans use the same key.</span>
      </li>
    </ol>
  );
}

function DeviceCodeStep({
  code,
  url,
  copied,
  onCopy,
}: {
  code: string;
  url: string | null;
  copied: boolean;
  onCopy: (code: string) => void;
}) {
  const host = url ? safeHost(url) : null;
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {host
          ? `Enter this code on ${host} to approve BloxBot.`
          : "Enter this code to approve BloxBot."}
      </p>
      <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2.5">
        <span className="select-all font-mono text-lg font-semibold tracking-[0.2em]">{code}</span>
        <button
          onClick={() => onCopy(code)}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Waiting for approval…
        </span>
        {url && <ReopenLink url={url} label={host ? `Open ${host}` : "Open the page"} />}
      </div>
    </div>
  );
}

function ReopenLink({ url, label }: { url: string; label: string }) {
  return (
    <button
      onClick={() => {
        desktop.openUrl(url).catch(() => {});
      }}
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </button>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export default ProviderConnectDialog;
