import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { ROBLOX_API_KEYS_URL } from "@/lib/robloxKeys";
import { requestSettings } from "@/lib/settingsRequest";
import { offerUploadsOnce } from "@/lib/uploadOffer";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { ModelUploadFailure, ModelUploadResult, ModelUploadStep } from "@/types/desktop";

const ModelPreview = lazy(() => import("@/components/ModelPreview"));

const RESPONSIBLE =
  "This uploads it to your Roblox account, and Roblox holds you responsible for it. Check it first.";

const STEP_TEXT: Record<ModelUploadStep, string> = {
  uploading: "Uploading to Roblox",
  checking: "Roblox is checking it. You can keep working while this runs.",
  adding: "Adding it to your place",
};

const FAILURES: Record<ModelUploadFailure, string> = {
  no_file: "The file has moved. Ask for it to be exported again.",
  file_changed:
    "The file changed after this preview, so nothing was uploaded. Check the new version first.",
  no_key: "Uploads are off. Turn them on in Settings, 3D tools.",
  no_studio: "Studio didn't answer. Open this place in Studio, then try again.",
  key_off:
    "Roblox turned your key off, usually because it went unused for 60 days. On Roblox, click Edit on the key and switch Enable Key off and back on.",
  key_rejected:
    "Roblox refused your key. Turn uploads off in Settings, 3D tools, and add a new one.",
  rate_limited: "Roblox asked BloxBot to slow down. Try again in a minute.",
  file_rejected: "Roblox refused the file. Ask for it to be exported again as FBX.",
  network: "Couldn't reach Roblox. Check your connection, then try again.",
};

const buttonClass = "rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent";
const primaryClass =
  "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90";

function HandSteps({ fileName }: { fileName: string }) {
  return (
    <>
      <p className="text-xs">To add it to your place:</p>
      <ol className="list-decimal space-y-0.5 pl-4 text-xs">
        <li>In Studio, open the File menu and choose Import.</li>
        <li>Pick {fileName}.</li>
        <li>Check the settings, then click Import.</li>
      </ol>
      <p className="text-xs text-muted-foreground">{RESPONSIBLE}</p>
    </>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border px-1.5 py-0.5 font-sans text-[11px] transition-colors hover:bg-accent"
      onClick={() => {
        navigator.clipboard
          ?.writeText(path)
          .then(() => setCopied(true))
          .catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy path"}
    </button>
  );
}

/** Shown under a reply that links to a model. Nothing leaves the computer until Upload is pressed. */
export function ModelCard({ url }: { url: string }) {
  const queryClient = useQueryClient();
  const studioKey = useStudioTargetOptional()?.selected?.key ?? null;
  const [declined, setDeclined] = useState(false);
  const [step, setStep] = useState<ModelUploadStep | null>(null);
  const [result, setResult] = useState<ModelUploadResult | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const failPreview = useCallback(() => setPreviewFailed(true), []);

  const { data: file } = useQuery({
    queryKey: qk.modelFile(url),
    queryFn: () => desktop.readModelFile(url),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const { data: uploads } = useQuery({
    queryKey: qk.robloxUpload,
    queryFn: () => desktop.getRobloxUploadState(),
  });
  const uploadsOn = uploads?.state === "on";
  const shown = !!file;

  useEffect(
    () =>
      desktop.onModelUploadStep((stepUrl, nextStep) => {
        if (stepUrl === url) setStep(nextStep);
      }),
    [url],
  );
  useEffect(() => {
    if (shown && uploads?.state === "off") offerUploadsOnce(url).catch(() => {});
  }, [shown, uploads?.state, url]);

  const upload = useMutation<ModelUploadResult, Error, string>({
    mutationFn: (studio) => desktop.uploadModelToPlace(url, studio, file?.hash ?? ""),
    onMutate: () => {
      setResult(null);
      setStep("uploading");
      posthog.capture("model_upload_started", analyticsProperties("model_card"));
    },
    onSuccess: (next) => {
      setResult(next);
      posthog.capture(
        "model_upload_finished",
        analyticsProperties("model_card", {
          outcome: next.status,
          reason: next.status === "failed" ? next.reason : undefined,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: qk.modelFile(url) });
    },
    onError: () => setResult({ status: "failed", reason: "network" }),
    onSettled: () => setStep(null),
  });

  if (!file) return null;

  const start = studioKey ? () => upload.mutate(studioKey) : undefined;
  const sent = result ? null : file.sent;
  const rejected = result?.status === "rejected" || sent?.moderation === "rejected";
  const added = result?.status === "added";
  const assetId = result && "assetId" in result ? result.assetId : sent?.assetId;

  const uploadButton = (label: string) => (
    <button type="button" className={primaryClass} aria-disabled={!start} onClick={start}>
      {label}
    </button>
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
            <div className="h-full w-full animate-pulse bg-foreground/70" />
          </div>
        </>
      );
    }
    if (added) {
      return (
        <>
          <output className="block text-xs font-medium text-success">
            Uploaded and added to your place
          </output>
          <p className="text-xs">
            It's in Workspace, and it's on your Roblox account as asset {assetId}.
          </p>
        </>
      );
    }
    if (rejected) {
      return (
        <>
          <p role="alert" className="text-xs font-medium text-destructive">
            Roblox rejected it
          </p>
          <p className="text-xs">
            It wasn't added to your place, and BloxBot won't send this file again. Roblox may also
            warn your account, so check your Roblox messages.
          </p>
        </>
      );
    }
    if (result?.status === "wrong_account") {
      return (
        <>
          <p role="alert" className="text-xs">
            Your key belongs to {result.keyOwner}, but Studio is signed in to {result.studio}.
            Nothing was uploaded, because Studio couldn't load it. Switch Studio to{" "}
            {result.keyOwner}, or make a key on {result.studio}.
          </p>
          <div className="flex flex-wrap gap-1.5">{uploadButton("Try again")}</div>
        </>
      );
    }
    if (result?.status === "failed") {
      return (
        <>
          <p role="alert" className="text-xs">
            {FAILURES[result.reason]}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {result.reason === "key_off" ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => desktop.openUrl(ROBLOX_API_KEYS_URL).catch(() => {})}
              >
                Open API Keys page
              </button>
            ) : null}
            {result.reason === "no_key" || result.reason === "key_rejected" ? (
              <button
                type="button"
                className={buttonClass}
                onClick={() => requestSettings("uploads")}
              >
                Open Settings
              </button>
            ) : null}
            {result.reason === "file_changed" ? (
              <button type="button" className={primaryClass} onClick={() => setResult(null)}>
                Check the new version
              </button>
            ) : result.reason !== "no_file" ? (
              uploadButton("Try again")
            ) : null}
          </div>
        </>
      );
    }
    if (result?.status === "checking" || sent?.moderation === "checking") {
      return (
        <>
          <p className="text-xs">
            Roblox is still checking it. It stays out of your place until Roblox approves it.
          </p>
          <div className="flex flex-wrap gap-1.5">{uploadButton("Check again")}</div>
        </>
      );
    }
    if (result?.status === "not_added" || sent?.moderation === "approved") {
      return (
        <>
          <p className="text-xs">
            {result
              ? "Roblox approved it, but Studio couldn't add it."
              : "Already on your Roblox account."}{" "}
            Asset {assetId}.
          </p>
          <div className="flex flex-wrap gap-1.5">{uploadButton("Add it to your place")}</div>
        </>
      );
    }
    if (!uploadsOn) return <HandSteps fileName={file.fileName} />;
    if (declined) {
      return (
        <>
          <p className="text-xs">
            Not uploaded. Nothing went to Roblox, and the file stays in its folder.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className={buttonClass} onClick={() => setDeclined(false)}>
              Upload after all
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <p className="text-xs">{RESPONSIBLE}</p>
        {start ? null : (
          <p className="text-xs text-muted-foreground">Open your place in Studio to upload this.</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {uploadButton("Upload to Roblox")}
          <button type="button" className={buttonClass} onClick={() => setDeclined(true)}>
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
            />
          </Suspense>
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2">
        <h3 className="text-sm font-medium">{file.name}</h3>
        <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="break-all">
            {file.fileName}, {Math.max(1, Math.round(file.sizeBytes / 1024))} KB
          </span>
          <CopyPath path={file.path} />
        </div>
        {body()}
      </div>
    </section>
  );
}
