import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { useEffect, useRef, useState } from "react";
import { RobloxUploadsCard } from "@/components/RobloxUploadsCard";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import type { BlenderFailureReason, BlenderSetupProgress } from "@/types/desktop";

const FAILURES: Record<BlenderFailureReason, string> = {
  disk_full: "Your drive is nearly full. Free up about 2 GB, then try again.",
  network:
    "The download stopped. Check your connection, then try again. It picks up where it left off.",
  blocked: "Security software blocked this. Allow BloxBot, then try again.",
  corrupt: "The download came through damaged. Try again.",
  other: "Blender couldn't be set up. Try again, or email support@bloxbot.ai if it keeps failing.",
};

function failureReason(error: Error): BlenderFailureReason {
  const reason = /\(reason: ([a-z_]+)\)/.exec(error.message)?.[1];
  return reason && reason in FAILURES ? (reason as BlenderFailureReason) : "other";
}

function progressLabel(progress: BlenderSetupProgress | null): string {
  if (progress?.step === "unpacking") return "Unpacking Blender";
  if (progress?.step === "connecting") return "Connecting Blender to BloxBot";
  if (!progress) return "Starting";
  return `Downloading ${Math.round((progress.downloadedBytes / progress.totalBytes) * 100)}%`;
}

function BlenderCard() {
  const { client } = useOpenCodeClient();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<BlenderSetupProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const stoppedRef = useRef(false);
  const { data: state } = useQuery({
    queryKey: qk.blenderTools,
    queryFn: () => desktop.getBlenderToolsState(),
    // Blender opening and closing happens outside BloxBot.
    refetchInterval: 3_000,
  });
  useEffect(() => desktop.onBlenderSetupProgress(setProgress), []);
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.blenderTools });

  const setup = useMutation<void, Error>({
    mutationFn: async () => {
      await desktop.installBlenderTools();
      // A chat already running keeps going, and its next message can reach Blender.
      await client?.instance.dispose({}, { throwOnError: true });
    },
    onMutate: () => {
      stoppedRef.current = false;
      setFailure(null);
      setProgress(null);
      posthog.capture("blender_setup_started", analyticsProperties("three_d_tools"));
    },
    onSuccess: () => {
      posthog.capture("blender_setup_finished", analyticsProperties("three_d_tools"));
      notify.success("Blender is ready");
    },
    onError: (error) => {
      // Stopping isn't a failure, and what downloaded so far is still there for next time.
      if (stoppedRef.current) return;
      const reason = failureReason(error);
      setFailure(FAILURES[reason]);
      posthog.capture(
        "blender_setup_failed",
        analyticsProperties("three_d_tools", { outcome: "error", reason }),
      );
    },
    onSettled: refresh,
  });
  const remove = useMutation<void, Error>({
    mutationFn: async () => {
      await desktop.removeBlenderTools();
      await client?.instance.dispose({}, { throwOnError: true });
    },
    onSuccess: () => posthog.capture("blender_removed", analyticsProperties("three_d_tools")),
    onError: () =>
      notify.error("Couldn't remove Blender", { description: "Close Blender, then try again." }),
    onSettled: refresh,
  });
  const open = useMutation<void, Error>({
    mutationFn: () => desktop.openBlender(),
    onSuccess: () => posthog.capture("blender_opened", analyticsProperties("three_d_tools")),
    onError: () =>
      notify.error("Couldn't open Blender", { description: "Set it up again from here." }),
  });

  const installing = setup.isPending || state?.state === "installing";
  const shown = progress ?? (state?.state === "installing" ? state.progress : null);
  const fraction =
    shown?.step === "downloading" && shown.totalBytes > 0
      ? shown.downloadedBytes / shown.totalBytes
      : undefined;

  if (state?.state === "unsupported") {
    return (
      <div className="rounded-lg border bg-card p-3">
        <p className="text-sm font-medium">Blender</p>
        <p className="mt-1 text-xs text-muted-foreground">Not available on this computer.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-sm font-medium">Blender</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Free, open-source 3D software. About 400 MB to download and 1.1 GB once installed. It runs
        code the AI writes on your computer, so save your work first.
      </p>

      {installing ? (
        <div className="mt-3">
          <output className="block text-xs text-muted-foreground">{progressLabel(shown)}</output>
          <div
            role="progressbar"
            aria-label="Setting up Blender"
            aria-valuenow={fraction === undefined ? undefined : Math.round(fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full bg-foreground/70 ${fraction === undefined ? "w-full animate-pulse" : ""}`}
              style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              stoppedRef.current = true;
              void desktop.cancelBlenderTools();
            }}
            className="mt-2 text-xs underline underline-offset-2 hover:text-foreground"
          >
            Stop
          </button>
        </div>
      ) : state?.state === "ready" ? (
        <div className="mt-3">
          <output className="block text-xs text-muted-foreground">
            {state.running ? "Open and connected." : "Ready. Open it when you want to use it."}
          </output>
          <div className="mt-2 flex items-center gap-3">
            {state.running ? null : (
              <button
                type="button"
                onClick={() => open.mutate()}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open Blender
              </button>
            )}
            {state.running ? (
              <p className="text-xs text-muted-foreground">Close Blender to remove it.</p>
            ) : (
              <button
                type="button"
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (!remove.isPending) remove.mutate();
                }}
                className="text-xs underline underline-offset-2 hover:text-foreground"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ) : state ? (
        <div className="mt-3">
          {failure ? (
            <p role="alert" className="mb-2 text-xs leading-relaxed text-destructive">
              {failure}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setup.mutate()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            {failure ? "Try again" : "Set up Blender"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function ThreeDToolsTab({ openUploads = false }: { openUploads?: boolean }) {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 @xl:px-6 @xl:py-8">
      <h4 className="text-lg font-medium text-foreground">3D tools</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Optional tools for making 3D models. BloxBot earns nothing from these.
      </p>
      <div className="mt-6 space-y-3">
        <BlenderCard />
        <RobloxUploadsCard startOpen={openUploads} />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
        Everything you add goes on your own Roblox account. Roblox moderates every upload and bans
        accounts for what breaks its rules, so check a model before you upload it.
      </p>
    </div>
  );
}
