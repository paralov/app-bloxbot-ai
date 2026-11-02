import { Paperclip } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ModelStatusBadge from "@/components/ModelStatusBadge";
import PromptEditor, { type PromptEditorHandle } from "@/components/PromptEditor";
import {
  MENU_TRIGGER,
  MenuChevron,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSearch,
} from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAbort } from "@/hooks/mutations/useAbort";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { useComposerCommands } from "@/hooks/useComposerCommands";
import { useAllModels, useConnectedProviders } from "@/hooks/useProviders";
import { useIsBusy } from "@/hooks/useSessionStatuses";
import { desktop } from "@/lib/desktop";
import { sortExplorerSnapshot } from "@/lib/explorer";
import { notify } from "@/lib/notifications";
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
                notify.error("Couldn't stop the session", {
                  description: error.message,
                });
              },
            })
          }
          disabled={abort.isPending}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground transition-colors hover:bg-accent hover:text-foreground"
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity disabled:opacity-30"
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

const EFFORT_LABELS: Record<string, string> = {
  none: "No",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** OpenCode's names for a model's thinking levels, or Auto when the model decides. */
function effortLabel(variant: string | null): string {
  if (!variant) return "Auto";
  return EFFORT_LABELS[variant] ?? variant;
}

function ChatInput({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { pendingReference, consumeReference, objects, publishObjects } = useExplorerReference();
  const allModels = useAllModels();
  const connectedProviders = useConnectedProviders();
  const { activeSessionId, activeSessionIdRef } = useActiveSession();
  const isBusy = useIsBusy(activeSessionId);
  const { selectedModel, selectedVariant, hiddenModels, setSelectedModel, setSelectedVariant } =
    usePreferences();
  const studioTarget = useStudioTargetOptional();
  const studioTargetReference = studioTarget?.promptReference ?? null;
  const studioId = studioTarget?.selected?.key ?? null;
  const { commands, run: runCommand } = useComposerCommands({
    chooseModel: () => setShowModelPicker(true),
    openSettings: () => onOpenSettings?.(),
    restoreDraft: (draft, sessionID) => {
      if (activeSessionIdRef.current === sessionID) promptEditorRef.current?.insertText(draft);
    },
  });
  const [objectsLoading, setObjectsLoading] = useState(false);
  const [objectsFailed, setObjectsFailed] = useState(false);
  const objectsRequest = useRef(0);

  // Objects belong to one place, so a different Studio starts with none.
  useEffect(() => {
    objectsRequest.current += 1;
    publishObjects([]);
    setObjectsLoading(false);
  }, [studioId, publishObjects]);

  // The Explorer panel may be closed, so "@" fetches what it can offer itself.
  const loadObjects = useCallback(() => {
    if (!studioId) return;
    const request = ++objectsRequest.current;
    setObjectsLoading(true);
    setObjectsFailed(false);
    desktop
      .getExplorerSnapshot(studioId)
      .then((snapshot) => {
        if (request !== objectsRequest.current) return;
        publishObjects(sortExplorerSnapshot(snapshot).roots);
      })
      .catch((error) => {
        console.error("[composer] couldn't read Studio objects", error);
        if (request === objectsRequest.current) setObjectsFailed(true);
      })
      .finally(() => {
        if (request === objectsRequest.current) setObjectsLoading(false);
      });
  }, [studioId, publishObjects]);

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
  const [modelSearch, setModelSearch] = useState("");
  const [rejectShake, setRejectShake] = useState(false);
  const promptEditorRef = useRef<PromptEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const [effortOpen, setEffortOpen] = useState(false);
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
      notify.error("Message not sent", { description: error.message });
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
          notify.error("That file isn't an image. Try a PNG, JPEG, GIF, or WebP instead.");
          triggerRejectShake();
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          notify.error("That image is too large. Please use one under 20 MB.");
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
          notify.error("Failed to read an image file");
          triggerRejectShake();
        }
      }
      if (succeeded.length === 0) return;
      setAttachments((prev) => {
        const remaining = MAX_ATTACHMENTS - prev.length;
        if (remaining <= 0) {
          notify.error(`Maximum ${MAX_ATTACHMENTS} images allowed`);
          triggerRejectShake();
          return prev;
        }
        const allowed = succeeded.slice(0, remaining);
        if (succeeded.length > remaining) {
          notify.error(`Only ${remaining} more image(s) allowed`);
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

  function handleSubmit() {
    const editorText = promptEditorRef.current?.getText() ?? text;
    const trimmed = editorText.trim();
    if (!trimmed && attachments.length === 0) return;
    const submittedText = editorText;
    const submittedAttachments = attachments;
    const images =
      attachments.length > 0
        ? attachments.map((a) => ({ mime: a.mime, url: a.dataUrl, filename: a.filename }))
        : undefined;
    const ranCommand = runCommand(trimmed, {
      images,
      system: studioTargetReference,
      onFailed: (error) => {
        notify.error("Command failed", { description: error.message });
        if (activeSessionIdRef.current !== activeSessionId) return;
        promptEditorRef.current?.insertText(submittedText);
        setAttachments(submittedAttachments);
      },
    });
    if (ranCommand) {
      setText("");
      setAttachments([]);
      promptEditorRef.current?.clear();
      return;
    }
    if (isBusy) return;
    failedSendRef.current = {
      sessionId: activeSessionId,
      text: submittedText,
      attachments: submittedAttachments,
    };
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

  const [selectedProviderId, selectedModelId] = selectedModel
    ? splitModelKey(selectedModel)
    : [undefined, undefined];
  const modelDisplay = selectedModelId
    ? (allModels.find(
        (model) => model.providerId === selectedProviderId && model.id === selectedModelId,
      )?.name ?? selectedModelId)
    : "Select model";

  function renderProviderGroup(
    providerId: string,
    group: { providerName: string; models: ModelInfo[] },
  ) {
    return (
      <div key={providerId}>
        <MenuLabel>{group.providerName}</MenuLabel>
        {group.models.map((model) => {
          const fullId = `${model.providerId}/${model.id}`;
          return (
            <MenuItem
              key={fullId}
              checked={selectedModel === fullId}
              onClick={() => handleModelClick(model)}
            >
              <span className="truncate">{model.name}</span>
              <ModelStatusBadge status={model.status} />
            </MenuItem>
          );
        })}
      </div>
    );
  }

  return (
    <div className="shrink-0 px-4 pb-3 pt-1">
      <div className="mx-auto max-w-2xl">
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
          data-composer=""
          className={`relative rounded-xl border bg-card transition-colors focus-within:border-foreground/20 ${isDragging ? "ring-2 ring-blue-400 border-blue-300 bg-blue-50/30" : ""}`}
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
                  <div className="mt-0.5 max-w-[64px] truncate text-center text-xs text-muted-foreground">
                    {a.filename}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex min-h-10 items-start px-2 pt-1.5">
            <PromptEditor
              ref={promptEditorRef}
              commands={commands}
              objects={objects}
              objectsLoading={objectsLoading}
              objectsUnavailable={
                !studioId
                  ? "Open a place in Studio to reference its objects."
                  : objectsFailed
                    ? "Couldn't read this place in Studio. Type @ again to retry."
                    : null
              }
              onObjectsWanted={loadObjects}
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
              placeholder={
                isDragging ? "Drop images here..." : "Describe what you want to build..."
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="relative flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={`flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${rejectShake ? "animate-reject-shake text-destructive" : ""}`}
                title="Attach images"
              >
                <Paperclip aria-hidden="true" size={14} />
              </button>

              <Popover
                open={showModelPicker}
                onOpenChange={(open) => {
                  setShowModelPicker(open);
                  if (!open) setModelSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <button type="button" className={MENU_TRIGGER}>
                    <span className="truncate">{modelDisplay}</span>
                    <MenuChevron />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="flex max-h-80 w-80 flex-col p-0!"
                >
                  <MenuSearch
                    inputRef={modelSearchRef}
                    value={modelSearch}
                    onChange={setModelSearch}
                    placeholder="Search models..."
                  />
                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {modelsByProvider.map(([id, group]) => renderProviderGroup(id, group))}
                    {modelsByProvider.length === 0 && (
                      <MenuLabel className="text-center">
                        No models matching "{modelSearch}"
                      </MenuLabel>
                    )}
                  </div>
                </PopoverContent>
              </Popover>

              {availableVariants.length > 0 && (
                <Popover open={effortOpen} onOpenChange={setEffortOpen}>
                  <PopoverTrigger asChild>
                    <button type="button" className={MENU_TRIGGER}>
                      {effortLabel(selectedVariant)} effort
                      <MenuChevron />
                    </button>
                  </PopoverTrigger>
                  <MenuContent side="top" align="start" className="w-56">
                    <MenuLabel>
                      How long the model thinks before it answers. More is slower.
                    </MenuLabel>
                    {[null, ...availableVariants].map((variant) => (
                      <MenuItem
                        key={variant ?? "auto"}
                        checked={selectedVariant === variant}
                        onClick={() => {
                          setSelectedVariant(variant);
                          setEffortOpen(false);
                        }}
                      >
                        {effortLabel(variant)}
                      </MenuItem>
                    ))}
                  </MenuContent>
                </Popover>
              )}
            </div>
            <SendButton
              text={text}
              hasAttachments={attachments.length > 0}
              isBusy={isBusy}
              onSend={handleSubmit}
            />
          </div>
        </div>
      </div>

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
