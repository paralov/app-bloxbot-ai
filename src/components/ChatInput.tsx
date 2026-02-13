import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { selectAvailableVariants, useStore } from "@/stores/opencode";
import type { ModelInfo } from "@/types";

// ── Image attachment helpers ────────────────────────────────────────────

interface ImageAttachment {
  id: string;
  dataUrl: string;
  mime: string;
  filename: string;
}

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_ATTACHMENTS = 5;

let attachmentCounter = 0;

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

// Known provider metadata for inline auth prompt
const PROVIDER_META: Record<string, { placeholder: string; helpUrl: string }> = {
  anthropic: { placeholder: "sk-ant-...", helpUrl: "https://console.anthropic.com/settings/keys" },
  openai: { placeholder: "sk-...", helpUrl: "https://platform.openai.com/api-keys" },
  google: { placeholder: "AIza...", helpUrl: "https://aistudio.google.com/app/apikey" },
};

// ── Lightbox overlay — shared between ChatInput preview strip ────────────

const LightboxOverlay = memo(function LightboxOverlay({
  urls,
  index,
  slideDir,
  animKey,
  onClose,
  onPrev,
  onNext,
}: {
  urls: string[];
  index: number;
  slideDir: "left" | "right" | null;
  animKey: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const hasMultiple = urls.length > 1;

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (hasMultiple && (e.key === "ArrowRight" || e.key === "ArrowDown")) onNext();
      if (hasMultiple && (e.key === "ArrowLeft" || e.key === "ArrowUp")) onPrev();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, onPrev, onNext, hasMultiple]);

  const slideClass =
    slideDir === "left"
      ? "animate-lightbox-slide-left"
      : slideDir === "right"
        ? "animate-lightbox-slide-right"
        : "animate-lightbox-image";

  return (
    <div
      className="animate-lightbox-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Close */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {/* Previous */}
      {hasMultiple && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:scale-110 hover:bg-white/20"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      {/* Image */}
      <img
        key={animKey}
        src={urls[index]}
        alt={`Attachment ${index + 1} of ${urls.length}`}
        className={`max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl ${slideClass}`}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Next */}
      {hasMultiple && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:scale-110 hover:bg-white/20"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {/* Counter pill */}
      {hasMultiple && (
        <div className="animate-fade-in-up absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
          {index + 1} / {urls.length}
        </div>
      )}
    </div>
  );
});

// ── Send/Abort button — isolated to avoid re-rendering the entire ChatInput ──

/** Tiny component that subscribes to isBusy + studioStatus so the rest
 *  of ChatInput (model picker, agent picker, auth UI) doesn't re-render
 *  on every busy toggle or studio status poll. */
const SendButton = memo(function SendButton({
  text,
  hasAttachments,
  onSend,
}: {
  text: string;
  hasAttachments: boolean;
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
          disabled={(!text.trim() && !hasAttachments) || !canSend}
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
  const {
    allModels,
    connectedProviders,
    hiddenModels,
    selectedModel,
    selectedAgent,
    selectedVariant,
    agents,
    authMethods,
  } = useStore(
    useShallow((s) => ({
      allModels: s.allModels,
      connectedProviders: s.connectedProviders,
      hiddenModels: s.hiddenModels,
      selectedModel: s.selectedModel,
      selectedAgent: s.selectedAgent,
      selectedVariant: s.selectedVariant,
      agents: s.agents,
      authMethods: s.authMethods,
    })),
  );
  const availableVariants = useStore(useShallow(selectAvailableVariants));

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lbSlideDir, setLbSlideDir] = useState<"left" | "right" | null>(null);
  const [lbAnimKey, setLbAnimKey] = useState(0);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [rejectShake, setRejectShake] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const oauthAbortRef = useRef<AbortController | null>(null);
  const dragCounterRef = useRef(0);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const triggerRejectShake = useCallback(() => {
    setRejectShake(true);
    clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setRejectShake(false), 600);
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      oauthAbortRef.current?.abort();
      clearTimeout(rejectTimerRef.current);
    };
  }, []);

  // ── Image attachment helpers ──────────────────────────────────────

  const addImageFiles = useCallback(
    async (files: FileList | File[]) => {
      const toAdd: File[] = [];
      for (const file of Array.from(files)) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          toast.error(`That file isn't an image. Try a PNG, JPEG, GIF, or WebP instead.`);
          triggerRejectShake();
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error(`That image is too large. Please use one under 20 MB.`);
          triggerRejectShake();
          continue;
        }
        toAdd.push(file);
      }
      if (toAdd.length === 0) return;

      // Read all files with allSettled — failed reads are skipped, not fatal
      const results = await Promise.allSettled(
        toAdd.map(async (file) => {
          const dataUrl = await fileToDataURL(file);
          return { dataUrl, mime: file.type, filename: file.name };
        }),
      );

      const succeeded: { dataUrl: string; mime: string; filename: string }[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          succeeded.push(r.value);
        } else {
          toast.error("Failed to read an image file");
          triggerRejectShake();
        }
      }
      if (succeeded.length === 0) return;

      // Enforce cap inside the updater so concurrent adds can't exceed MAX_ATTACHMENTS
      setAttachments((prev) => {
        const remaining = MAX_ATTACHMENTS - prev.length;
        if (remaining <= 0) {
          toast.error(`Maximum ${MAX_ATTACHMENTS} images allowed`);
          triggerRejectShake();
          return prev;
        }
        const allowed = succeeded.slice(0, remaining);
        if (succeeded.length > remaining) {
          toast.error(`Only ${remaining} more image(s) allowed`);
          triggerRejectShake();
        }
        // Generate IDs inside the updater so they're safe from strict-mode double-fire
        return [
          ...prev,
          ...allowed.map((s) => ({
            id: `img-${++attachmentCounter}`,
            dataUrl: s.dataUrl,
            mime: s.mime,
            filename: s.filename,
          })),
        ];
      });
    },
    [triggerRejectShake],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const lightboxUrls = useMemo(() => attachments.map((a) => a.dataUrl), [attachments]);

  // Stable lightbox callbacks — avoids breaking LightboxOverlay's memo
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const lightboxPrev = useCallback(() => {
    setLbSlideDir("right");
    setLbAnimKey((k) => k + 1);
    setLightboxIndex((i) =>
      i !== null ? (i - 1 + attachments.length) % attachments.length : null,
    );
  }, [attachments.length]);
  const lightboxNext = useCallback(() => {
    setLbSlideDir("left");
    setLbAnimKey((k) => k + 1);
    setLightboxIndex((i) => (i !== null ? (i + 1) % attachments.length : null));
  }, [attachments.length]);

  // Stable drag handlers — avoids recreating on every render
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragging(true);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        addImageFiles(e.dataTransfer.files);
      }
    },
    [addImageFiles],
  );

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

  // Auto-resize textarea — done imperatively in the onChange handler
  // to avoid an extra render cycle from a useEffect.
  function resizeTextarea(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

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
      useStore.getState().setSelectedModel(pendingModelId);
      setAuthProviderId(null);
      setPendingModelId(null);
      setApiKeyInput("");
      setAuthError(null);
      setAuthOauthLoading(false);
      setAuthOauthInstructions(null);
      setModelSearch("");
      setShowModelPicker(false);
    }
  }, [connectedProviders, authProviderId, pendingModelId]);

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
    if (!trimmed && attachments.length === 0) return;
    const s = useStore.getState();
    if (s.isBusy || s.studioStatus !== "connected") return;
    const images =
      attachments.length > 0
        ? attachments.map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.filename }))
        : undefined;
    s.sendMessage(trimmed || " ", images);
    setText("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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
      useStore.getState().setSelectedModel(fullId);
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
                        useStore.getState().setSelectedAgent(agent.name);
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
                useStore.getState().setSelectedVariant(availableVariants[0]);
              } else {
                const idx = availableVariants.indexOf(selectedVariant);
                if (idx === -1 || idx === availableVariants.length - 1) {
                  useStore.getState().setSelectedVariant(null);
                } else {
                  useStore.getState().setSelectedVariant(availableVariants[idx + 1]);
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

      {/* Hidden file input for click-to-attach */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addImageFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* Input area — drag-and-drop target */}
      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`rounded-xl border bg-background transition-shadow focus-within:ring-2 ring-ring/20 ${
          isDragging ? "ring-2 ring-blue-400 border-blue-300 bg-blue-50/30" : ""
        }`}
      >
        {/* Image preview strip */}
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-2 pb-1">
            {attachments.map((a, idx) => (
              <div key={a.id} className="group relative shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(idx);
                    setLbSlideDir(null);
                    setLbAnimKey((k) => k + 1);
                  }}
                  className="block cursor-zoom-in overflow-hidden rounded-lg border transition-opacity hover:opacity-80"
                >
                  <img src={a.dataUrl} alt={a.filename} className="h-16 w-16 object-cover" />
                </button>
                <button
                  onClick={() => removeAttachment(a.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100"
                  title="Remove"
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
                <div className="mt-0.5 max-w-[64px] truncate text-center text-[9px] text-muted-foreground">
                  {a.filename}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Text input row */}
        <div className="flex items-center gap-1 px-3 py-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className={`shrink-0 p-0.5 transition-colors hover:text-foreground ${
              rejectShake ? "animate-reject-shake text-red-500" : "text-muted-foreground/60"
            }`}
            title="Attach images"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              resizeTextarea(e.target);
            }}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              const items = e.clipboardData.items;
              const imageFiles: File[] = [];
              for (const item of Array.from(items)) {
                if (item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type)) {
                  const file = item.getAsFile();
                  if (file) imageFiles.push(file);
                }
              }
              if (imageFiles.length > 0) {
                e.preventDefault();
                addImageFiles(imageFiles);
              }
            }}
            placeholder={isDragging ? "Drop images here..." : "Describe what you want to build..."}
            rows={1}
            className="max-h-40 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none"
          />
          <SendButton text={text} hasAttachments={attachments.length > 0} onSend={handleSubmit} />
        </div>
      </div>

      <StatusHint />

      {/* Lightbox overlay — cycling through attachments */}
      {lightboxIndex !== null && attachments[lightboxIndex] && (
        <LightboxOverlay
          urls={lightboxUrls}
          index={lightboxIndex}
          slideDir={lbSlideDir}
          animKey={lbAnimKey}
          onClose={closeLightbox}
          onPrev={lightboxPrev}
          onNext={lightboxNext}
        />
      )}
    </div>
  );
}

export default ChatInput;
