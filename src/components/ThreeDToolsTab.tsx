import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Box, type LucideIcon, Upload } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { RobloxKeyWizard } from "@/components/RobloxKeyWizard";
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

const primary =
  "whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90";
const quiet =
  "whitespace-nowrap rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

function StatePill({ on, children }: { on?: boolean; children: ReactNode }) {
  return (
    <output
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
        on
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"
          : "bg-muted text-muted-foreground"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
      />
      {children}
    </output>
  );
}

function ToolRow({
  icon: Icon,
  name,
  state,
  actions,
  children,
}: {
  icon: LucideIcon;
  name: string;
  state?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-muted">
          <Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            {state}
          </div>
          <div className="mt-0.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
            {children}
          </div>
          {actions ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">{actions}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BlenderRow() {
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
      <ToolRow icon={Box} name="Blender">
        <p>Not available on this computer.</p>
      </ToolRow>
    );
  }

  const ready = state?.state === "ready";
  return (
    <ToolRow
      icon={Box}
      name="Blender"
      state={
        installing ? null : ready ? (
          <StatePill on={state.running}>{state.running ? "Open" : "Ready"}</StatePill>
        ) : (
          <StatePill>Free</StatePill>
        )
      }
      actions={
        installing ? null : ready ? (
          state.running ? null : (
            <>
              <button type="button" className={primary} onClick={() => open.mutate()}>
                Open Blender
              </button>
              <button
                type="button"
                className={quiet}
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (!remove.isPending) remove.mutate();
                }}
              >
                Remove
              </button>
            </>
          )
        ) : state ? (
          <button type="button" className={primary} onClick={() => setup.mutate()}>
            {failure ? "Try again" : "Set up Blender"}
          </button>
        ) : null
      }
    >
      {ready ? (
        <p>
          {state.running
            ? "The AI can use it now. Close Blender to remove it."
            : "Open it when you want the AI to make a model."}
        </p>
      ) : (
        <>
          <p>Free, open-source 3D software. About 400 MB to download, 1.1 GB once installed.</p>
          <p>It runs code the AI writes on your computer, so save your work first.</p>
        </>
      )}
      {failure && !installing ? (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {failure}
        </p>
      ) : null}
      {installing ? (
        <div className="pt-1.5">
          <div className="flex items-center justify-between gap-3">
            <output className="block text-foreground">{progressLabel(shown)}</output>
            <button
              type="button"
              onClick={() => {
                stoppedRef.current = true;
                void desktop.cancelBlenderTools();
              }}
              className="transition-colors hover:text-foreground"
            >
              Stop
            </button>
          </div>
          <div
            role="progressbar"
            aria-label="Setting up Blender"
            aria-valuenow={fraction === undefined ? undefined : Math.round(fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={`h-full rounded-full bg-foreground/70 transition-[width] ${fraction === undefined ? "w-full animate-pulse" : ""}`}
              style={fraction === undefined ? undefined : { width: `${fraction * 100}%` }}
            />
          </div>
        </div>
      ) : null}
    </ToolRow>
  );
}

function UploadsRow({ onSetUp }: { onSetUp: () => void }) {
  const queryClient = useQueryClient();
  const { data: uploads } = useQuery({
    queryKey: qk.robloxUpload,
    queryFn: () => desktop.getRobloxUploadState(),
  });
  const turnOff = useMutation<void, Error>({
    mutationFn: () => desktop.forgetRobloxKey(),
    onSuccess: () => {
      posthog.capture("roblox_uploads_turned_off", analyticsProperties("three_d_tools"));
      notify.success("Uploads are off", {
        description: "BloxBot forgot the key. Delete it on Roblox too.",
      });
      void queryClient.invalidateQueries({ queryKey: qk.robloxUpload });
    },
    onError: () => notify.error("Couldn't forget the key", { description: "Try again." }),
  });
  if (!uploads) return null;

  if (uploads.state === "unavailable") {
    return (
      <ToolRow icon={Upload} name="Upload to Roblox">
        <p>This computer can't store a key safely, so import models through Studio instead.</p>
      </ToolRow>
    );
  }
  if (uploads.state === "on") {
    return (
      <ToolRow
        icon={Upload}
        name="Upload to Roblox"
        state={<StatePill on>On</StatePill>}
        actions={
          <button type="button" className={quiet} onClick={() => turnOff.mutate()}>
            Turn off and forget the key
          </button>
        }
      >
        <p>
          Models go to {uploads.ownerName ?? `account ${uploads.ownerId}`} after you click Upload on
          each one.
        </p>
      </ToolRow>
    );
  }
  return (
    <ToolRow
      icon={Upload}
      name="Upload to Roblox"
      state={<StatePill>Off</StatePill>}
      actions={
        <button
          type="button"
          className="whitespace-nowrap rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
          onClick={onSetUp}
        >
          Set up uploads
        </button>
      }
    >
      <p>
        You import models through Studio. Turn this on to add them with one click, after you check
        each one.
      </p>
    </ToolRow>
  );
}

export function ThreeDToolsTab({ openUploads = false }: { openUploads?: boolean }) {
  const [connecting, setConnecting] = useState(openUploads);
  useEffect(() => {
    if (openUploads) setConnecting(true);
  }, [openUploads]);

  if (connecting) return <RobloxKeyWizard onClose={() => setConnecting(false)} />;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 @xl:px-6 @xl:py-8">
      <h4 className="text-lg font-medium text-foreground">3D tools</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Optional. BloxBot earns nothing from these.
      </p>
      <div className="mt-6 divide-y rounded-lg border bg-card">
        <BlenderRow />
        <UploadsRow onSetUp={() => setConnecting(true)} />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        Everything you add goes on your own Roblox account. Roblox moderates every upload and bans
        accounts for what breaks its rules, so check a model before it goes up.
      </p>
    </div>
  );
}
