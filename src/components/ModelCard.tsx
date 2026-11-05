import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { UploadChecklist } from "@/components/UploadChecklist";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { useUploadAccess } from "@/hooks/useUploadAccess";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { ModelUploadFailure, ModelUploadResult, ModelUploadStep } from "@/types/desktop";

const ModelPreview = lazy(() => import("@/components/ModelPreview"));

const RESPONSIBLE =
  "Uploads are permanent and go on the account that owns this game. Roblox holds you responsible for them, so check it first.";

const STEP_TEXT: Record<ModelUploadStep, string> = {
  uploading: "Uploading to Roblox",
  checking: "Roblox is checking it. You can keep working while this runs.",
  adding: "Adding it to your place",
};

const FAILURES: Record<ModelUploadFailure, string> = {
  no_file: "The file has moved. Ask for it to be exported again.",
  file_changed:
    "The file changed after this preview, so nothing was uploaded. Check the new version first.",
  refused: "Roblox refused this from Studio. You can still import it yourself below.",
  rate_limited: "Roblox asked BloxBot to slow down. Try again in a minute.",
  file_rejected: "Roblox refused the file. Ask for it to be exported again.",
  studio_error: "Studio didn't answer. Make sure this place is open, then try again.",
};

const secondary = "rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent";
const primary =
  "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90";

function ImportByHand({ fileName, open }: { fileName: string; open?: boolean }) {
  return (
    <details open={open} className="text-xs">
      <summary className="cursor-pointer text-muted-foreground transition-colors hover:text-foreground">
        Import it yourself
      </summary>
      <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 leading-relaxed">
        <li>In Studio, open the File menu and choose Import.</li>
        <li>Pick {fileName}.</li>
        <li>Check the settings, then click Import.</li>
      </ol>
    </details>
  );
}

/** Shown under a reply that links to a model. Nothing leaves the computer until Upload is pressed. */
export function ModelCard({ url }: { url: string }) {
  const queryClient = useQueryClient();
  const studio = useStudioTargetOptional();
  const selected = studio?.selected ?? null;
  const studioKey = selected?.key ?? null;
  const sendMessage = useSendMessage();
  const [declined, setDeclined] = useState(false);
  const [askedToFix, setAskedToFix] = useState(false);
  const [step, setStep] = useState<ModelUploadStep | null>(null);
  const [result, setResult] = useState<ModelUploadResult | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const failPreview = useCallback(() => setPreviewFailed(true), []);
  const [drawn, setDrawn] = useState<Uint8Array | null>(null);
  // The fix has to reach the place this went to, even if someone has since chosen another.
  const uploadedTo = useRef<string | null>(null);

  const { data: file } = useQuery({
    queryKey: qk.modelFile(url),
    queryFn: () => desktop.readModelFile(url),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const { data: access } = useUploadAccess(selected, url, !!file && !!studioKey);
  const accessState = studioKey ? access?.state : "no_studio";

  // A folder refusal came from the Studio the upload went to, so it doesn't apply to another one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs when the chosen Studio changes.
  useEffect(() => {
    setResult((current) => (current?.status === "needs_folder" ? null : current));
  }, [studioKey]);

  useEffect(
    () =>
      desktop.onModelUploadStep((stepUrl, nextStep) => {
        if (stepUrl === url) setStep(nextStep);
      }),
    [url],
  );

  const refreshAccess = () =>
    queryClient.invalidateQueries({ queryKey: qk.uploadAccess(selected, url) });

  const upload = useMutation<ModelUploadResult, Error, string>({
    mutationFn: (key) => desktop.uploadModelToPlace(url, key, file?.hash ?? ""),
    onMutate: () => {
      uploadedTo.current = studio?.promptReference ?? null;
      setResult(null);
      setStep("uploading");
      posthog.capture("model_upload_started", analyticsProperties("model_card"));
    },
    onSuccess: (next) => {
      setResult(next.status === "needs_setup" ? null : next);
      posthog.capture(
        "model_upload_finished",
        analyticsProperties("model_card", {
          outcome: next.status,
          reason: next.status === "failed" ? next.reason : undefined,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: qk.modelFile(url) });
      void refreshAccess();
    },
    onError: () => setResult({ status: "failed", reason: "studio_error" }),
    onSettled: () => setStep(null),
  });

  if (!file) return null;

  // Upload sends this file's hash, so it waits until this same file is the one on screen.
  const previewed = previewFailed || drawn === file.data;
  const start = studioKey && previewed ? () => upload.mutate(studioKey) : undefined;
  const sent = result ? null : file.sent;
  const rejected = result?.status === "rejected" || sent?.moderation === "rejected";
  const assetId = result && "assetId" in result ? result.assetId : sent?.assetId;

  // A sent model's card can come back in a chat with no place chosen, where there's nowhere to send it.
  const uploadButton = (label: string) => (
    <>
      <button
        type="button"
        className={`${primary} disabled:opacity-50`}
        disabled={!start}
        onClick={start}
      >
        {label}
      </button>
      {start ? null : (
        <span className="self-center text-xs text-muted-foreground">
          {studio?.targets.length
            ? "Choose your place in the Studio picker first."
            : "Open your place in Studio first."}
        </span>
      )}
    </>
  );

  const body = () => {
    if (upload.isPending) {
      return (
        <>
          <output className="block text-xs">{STEP_TEXT[step ?? "uploading"]}</output>
          <div
            role="progressbar"
            aria-label={STEP_TEXT[step ?? "uploading"]}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full w-full animate-pulse rounded-full bg-foreground/70" />
          </div>
        </>
      );
    }
    if (result?.status === "added") {
      return (
        <>
          <output className="block text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Added to your place
          </output>
          <p className="text-xs leading-relaxed text-muted-foreground">
            It's at {result.path.replace(/^game\./, "")}. Imports often arrive the wrong size,
            unanchored and away from where you want them.
          </p>
          {askedToFix ? (
            <p className="text-xs text-muted-foreground">Asked BloxBot to fix it.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={primary}
                onClick={() => {
                  setAskedToFix(true);
                  posthog.capture("model_fix_requested", analyticsProperties("model_card"));
                  sendMessage.mutate({
                    text: `I just added ${file.name} to this place at ${result.path}, as asset ${result.assetId}, from ${file.path}. Follow steps 5 to 7 of the rbx-import-asset skill: compare it with the source file, then fix its scale, rotation, textures, colours, anchoring and placement. It's already uploaded, so don't upload the model again.`,
                    studioTargetReference: uploadedTo.current,
                  });
                }}
              >
                Fix size and placement
              </button>
            </div>
          )}
        </>
      );
    }
    if (rejected) {
      return (
        <>
          <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
            Roblox rejected it
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            It wasn't added to your place, and BloxBot won't send this file again. Roblox may also
            warn your account, so check your Roblox messages.
          </p>
        </>
      );
    }
    if (result?.status === "needs_folder" && access) {
      return (
        <>
          <p role="alert" className="text-xs">
            Nothing was uploaded, because Studio hasn't approved this file's folder.
          </p>
          <UploadChecklist access={access} folderRefused />
          <div className="flex flex-wrap gap-1.5">{uploadButton("Try again")}</div>
        </>
      );
    }
    if (result?.status === "failed") {
      return (
        <>
          <p role="alert" className="text-xs leading-relaxed">
            {FAILURES[result.reason]}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.reason === "file_changed" ? (
              <button type="button" className={primary} onClick={() => setResult(null)}>
                Check the new version
              </button>
            ) : result.reason !== "no_file" && result.reason !== "refused" ? (
              uploadButton("Try again")
            ) : null}
          </div>
          {result.reason === "refused" ? <ImportByHand fileName={file.fileName} open /> : null}
        </>
      );
    }
    if (result?.status === "checking" || sent?.moderation === "checking") {
      return (
        <>
          <p className="text-xs leading-relaxed">
            Roblox is still checking it. It stays out of your place until Roblox approves it.
          </p>
          <div className="flex flex-wrap gap-1.5">{uploadButton("Check again")}</div>
        </>
      );
    }
    if (result?.status === "not_added" || sent?.moderation === "approved") {
      return (
        <>
          <p className="text-xs leading-relaxed">
            {result
              ? "Roblox approved it, but Studio couldn't add it."
              : "Already on Roblox, so there's nothing to upload."}{" "}
            Asset {assetId}.
          </p>
          <div className="flex flex-wrap gap-1.5">{uploadButton("Add it to your place")}</div>
        </>
      );
    }
    if (accessState === "refused") {
      return (
        <>
          <p className="text-xs leading-relaxed">
            Roblox isn't accepting Studio's sign-in for uploads right now. Import it yourself, or
            try again later.
          </p>
          <ImportByHand fileName={file.fileName} open />
        </>
      );
    }
    if (access && accessState !== "ready" && studioKey) {
      return (
        <>
          <p className="text-xs font-medium">Turn on one-click uploads</p>
          <UploadChecklist access={access} />
          <ImportByHand fileName={file.fileName} />
        </>
      );
    }
    if (accessState !== "ready") {
      return (
        <>
          <ImportByHand fileName={file.fileName} open />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Importing uploads it too, and Roblox holds you responsible for it. Check it first.
          </p>
        </>
      );
    }
    if (declined) {
      return (
        <>
          <p className="text-xs leading-relaxed">
            Not uploaded. Nothing went to Roblox, and the file stays in its folder.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={secondary} onClick={() => setDeclined(false)}>
              Upload after all
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <p className="text-xs leading-relaxed text-muted-foreground">{RESPONSIBLE}</p>
        <div className="flex flex-wrap gap-1.5">
          {uploadButton("Upload to Roblox")}
          <button type="button" className={secondary} onClick={() => setDeclined(true)}>
            Don't upload
          </button>
        </div>
      </>
    );
  };

  return (
    <section
      aria-label={`Model ${file.name}`}
      className="mt-2 flex flex-wrap gap-3 rounded-lg border bg-card p-3"
    >
      <div className="w-[148px] flex-none">
        {previewFailed ? (
          <p className="flex h-[124px] items-center rounded-md bg-muted p-2 text-xs text-muted-foreground">
            Couldn't draw a preview. Open the file to check it before you upload.
          </p>
        ) : (
          <Suspense fallback={<div className="h-[124px] w-[148px] rounded-md bg-muted" />}>
            <ModelPreview
              data={file.data}
              kind={file.kind}
              name={file.name}
              onFailed={failPreview}
              onDrawn={setDrawn}
            />
          </Suspense>
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2">
        <div>
          <h3 className="text-sm font-medium">{file.name}</h3>
          <p className="break-all text-xs text-muted-foreground">
            {file.fileName}, {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
          </p>
        </div>
        {body()}
      </div>
    </section>
  );
}
