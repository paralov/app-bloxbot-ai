import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import PromptEditor, { type PromptEditorHandle } from "@/components/PromptEditor";
import { useAbort } from "@/hooks/mutations/useAbort";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { useAgents } from "@/hooks/useAgents";
import { useCommands } from "@/hooks/useCommands";
import { useAllModels, useConnectedProviders } from "@/hooks/useProviders";
import { useIsBusy } from "@/hooks/useSessionStatuses";
import { splitModelKey } from "@/lib/splitModelKey";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { usePreferences } from "@/providers/PreferencesProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { ModelInfo } from "@/types";

// ── Image attachment helpers ────────────────────────────────────────────

interface ImageAttachment {
  id: string;
  dataUrl: string;
  mime: string;
  filename: string;
}

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
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

// ── Lightbox overlay ────────────────────────────────────────────────────

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
      <button
        type="button"
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
      {hasMultiple && (
        <button
          type="button"
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
      <img
        key={animKey}
        src={urls[index]}
        alt={`Attachment ${index + 1} of ${urls.length}`}
        className={`max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl ${slideClass}`}
        onClick={(e) => e.stopPropagation()}
      />
      {hasMultiple && (
        <button
          type="button"
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
      {hasMultiple && (
        <div className="animate-fade-in-up absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
          {index + 1} / {urls.length}
        </div>
      )}
    </div>
  );
});

// ── Send/Abort button ───────────────────────────────────────────────────

const SendButton = memo(function SendButton({
  text,
  hasAttachments,
  isBusy,
  onSend,
}: {
  text: string;
  hasAttachments: boolean;
  isBusy: boolean;
  onSend: () => void;
}) {
  const abort = useAbort();
  const canSend = !isBusy;

  return (
    <>
      {isBusy ? (
        <button
          type="button"
          onClick={() =>
            abort.mutate(undefined, {
              onError: (error) => {
                toast.error("Couldn't stop the session", {
                  description: error.message,
                });
              },
            })
          }
          disabled={abort.isPending}
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Stop"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={(!text.trim() && !hasAttachments) || !canSend}
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-background transition-opacity disabled:opacity-30"
          title="Send"
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
  return (
    <div className="mt-1.5 text-center text-[10px] text-muted-foreground/50">
      Shift+Enter for new line
    </div>
  );
});

function ChatInput() {
  const { pendingReference, consumeReference, objects } = useExplorerReference();
  const allModels = useAllModels();
  const connectedProviders = useConnectedProviders();
  const agents = useAgents();
  const commands = useCommands();
  const { activeSessionId, activeSessionIdRef } = useActiveSession();
  const isBusy = useIsBusy(activeSessionId);
  const {
    selectedModel,
    selectedAgent,
    selectedVariant,
    hiddenModels,
    setSelectedModel,
    setSelectedAgent,
    setSelectedVariant,
  } = usePreferences();
  const studioTargetReference = useStudioTargetOptional()?.promptReference ?? null;

  // Available variants for the currently selected model
  const availableVariants = useMemo(() => {
    if (!selectedModel) return [];
    const [, modelId] = splitModelKey(selectedModel);
    const model = allModels.find((m) => m.id === modelId);
    return model?.variants ? Object.keys(model.variants) : [];
  }, [selectedModel, allModels]);

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
  const promptEditorRef = useRef<PromptEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const agentPickerRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const previousSessionRef = useRef(activeSessionId);
  const failedSendRef = useRef<{
    sessionId: string | null;
    text: string;
    attachments: ImageAttachment[];
  } | null>(null);
  const sendMessage = useSendMessage({
    onError: (error) => {
      const failed = failedSendRef.current;
      failedSendRef.current = null;
      if (!failed || activeSessionIdRef.current !== failed.sessionId) return;
      toast.error("Message not sent", { description: error.message });
      if (failed.text) promptEditorRef.current?.insertText(failed.text);
      setAttachments((current) => {
        const currentIds = new Set(current.map((attachment) => attachment.id));
        const restored = failed.attachments.filter((attachment) => !currentIds.has(attachment.id));
        return [...restored, ...current];
      });
    },
  });

  useEffect(() => {
    if (previousSessionRef.current === activeSessionId) return;
    previousSessionRef.current = activeSessionId;
    setText("");
    setAttachments([]);
    promptEditorRef.current?.clear();
  }, [activeSessionId]);

  useEffect(() => {
    if (!pendingReference) return;
    promptEditorRef.current?.insertText(pendingReference);
    consumeReference();
    requestAnimationFrame(() => promptEditorRef.current?.focus());
  }, [pendingReference, consumeReference]);

  const triggerRejectShake = useCallback(() => {
    setRejectShake(true);
    clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setRejectShake(false), 600);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(rejectTimerRef.current);
    };
  }, []);

  const addImageFiles = useCallback(
    async (files: FileList | File[]) => {
      const toAdd: File[] = [];
      for (const file of Array.from(files)) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          toast.error("That file isn't an image. Try a PNG, JPEG, GIF, or WebP instead.");
          triggerRejectShake();
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error("That image is too large. Please use one under 20 MB.");
          triggerRejectShake();
          continue;
        }
        toAdd.push(file);
      }
      if (toAdd.length === 0) return;
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
      if (e.dataTransfer.files.length > 0) addImageFiles(e.dataTransfer.files);
    },
    [addImageFiles],
  );

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
        setModelSearch("");
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

  const modelsByProvider = useMemo(() => {
    const POPULAR = [
      "opencode",
      "anthropic",
      "github-copilot",
      "openai",
      "google",
      "openrouter",
      "vercel",
    ];
    const query = modelSearch.toLowerCase().trim();
    const groups: Record<string, { providerName: string; models: ModelInfo[] }> = {};
    for (const model of allModels) {
      if (!connectedProviders.includes(model.providerId)) continue;
      const modelKey = `${model.providerId}/${model.id}`;
      if (hiddenModels.has(modelKey)) continue;
      if (query) {
        const haystack = `${model.name} ${model.id} ${model.providerName}`.toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      if (!groups[model.providerId])
        groups[model.providerId] = { providerName: model.providerName, models: [] };
      groups[model.providerId].models.push(model);
    }
    for (const group of Object.values(groups))
      group.models.sort((a, b) => a.name.localeCompare(b.name));
    // Sort provider groups: popular first, then alphabetical
    const entries = Object.entries(groups);
    entries.sort(([aId], [bId]) => {
      const aIdx = POPULAR.indexOf(aId);
      const bIdx = POPULAR.indexOf(bId);
      if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
      if (aIdx >= 0) return -1;
      if (bIdx >= 0) return 1;
      return groups[aId].providerName.localeCompare(groups[bId].providerName);
    });
    return entries;
  }, [allModels, connectedProviders, hiddenModels, modelSearch]);

  const visibleAgents = useMemo(
    () => agents.filter((a) => !a.hidden && (a.mode === "primary" || a.mode === "all")),
    [agents],
  );

  function handleSubmit() {
    const editorText = promptEditorRef.current?.getText() ?? text;
    const trimmed = editorText.trim();
    if (!trimmed && attachments.length === 0) return;
    if (isBusy) return;
    const submittedText = editorText;
    const submittedAttachments = attachments;
    failedSendRef.current = {
      sessionId: activeSessionId,
      text: submittedText,
      attachments: submittedAttachments,
    };
    const images =
      attachments.length > 0
        ? attachments.map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.filename }))
        : undefined;
    setText("");
    setAttachments([]);
    promptEditorRef.current?.clear();
    void sendMessage
      .mutateAsync({ text: trimmed || " ", images, studioTargetReference })
      .catch(() => undefined);
  }

  function handleModelClick(model: ModelInfo) {
    const fullId = `${model.providerId}/${model.id}`;
    setSelectedModel(fullId);
    setShowModelPicker(false);
    setModelSearch("");
  }

  const modelDisplay = selectedModel
    ? (selectedModel.split("/").pop() ?? selectedModel)
    : "Select model";
  const agentDisplay = selectedAgent ?? "Default agent";

  function statusBadge(status?: string) {
    if (status === "beta")
      return (
        <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-400">
          beta
        </span>
      );
    if (status === "alpha")
      return (
        <span className="shrink-0 rounded bg-purple-100 px-1 text-[9px] font-medium text-purple-700 dark:bg-purple-950/50 dark:text-purple-300">
          alpha
        </span>
      );
    if (status === "deprecated")
      return (
        <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-medium text-muted-foreground">
          deprecated
        </span>
      );
    return null;
  }

  function renderProviderGroup(
    providerId: string,
    group: { providerName: string; models: ModelInfo[] },
  ) {
    return (
      <div key={providerId}>
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {group.providerName}
          </span>
        </div>
        {group.models.map((model) => {
          const fullId = `${model.providerId}/${model.id}`;
          const isSelected = selectedModel === fullId;
          return (
            <button
              key={fullId}
              onClick={() => handleModelClick(model)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${isSelected ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            >
              <span className="truncate">{model.name}</span>
              {statusBadge(model.status)}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t bg-card px-4 py-3">
      <div className="relative mb-2 flex items-center gap-1">
        <div className="relative" ref={modelPickerRef}>
          <button
            onClick={() => {
              setShowModelPicker(!showModelPicker);
              setShowAgentPicker(false);
              if (showModelPicker) {
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
              <div className="flex-1 overflow-y-auto p-1">
                {modelsByProvider.map(([id, group]) => renderProviderGroup(id, group))}
                {modelsByProvider.length === 0 && (
                  <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                    No models matching "{modelSearch}"
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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
                      className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors ${isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
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

        {availableVariants.length > 0 && (
          <button
            onClick={() => {
              if (!selectedVariant) setSelectedVariant(availableVariants[0]);
              else {
                const idx = availableVariants.indexOf(selectedVariant);
                if (idx === -1 || idx === availableVariants.length - 1) setSelectedVariant(null);
                else setSelectedVariant(availableVariants[idx + 1]);
              }
            }}
            className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] capitalize text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={`Click to cycle variant (${["default", ...availableVariants].join(" → ")})`}
          >
            {selectedVariant ?? "default"}
          </button>
        )}
      </div>

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

      <div
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`rounded-xl border bg-background transition-shadow focus-within:ring-2 ring-ring/20 ${isDragging ? "ring-2 ring-blue-400 border-blue-300 bg-blue-50/30" : ""}`}
      >
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

        <div className="flex items-start gap-1 px-3 py-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className={`mt-0.5 shrink-0 p-0.5 transition-colors hover:text-foreground ${rejectShake ? "animate-reject-shake text-red-500" : "text-muted-foreground/60"}`}
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
          <PromptEditor
            ref={promptEditorRef}
            commands={commands}
            objects={objects}
            onChange={setText}
            onSubmit={handleSubmit}
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
          />
          <SendButton
            text={text}
            hasAttachments={attachments.length > 0}
            isBusy={isBusy}
            onSend={handleSubmit}
          />
        </div>
      </div>

      <StatusHint />

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
