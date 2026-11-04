import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { type ReactNode, useState } from "react";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import { ROBLOX_API_KEYS_URL } from "@/lib/robloxKeys";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { RobloxKeyCheck } from "@/types/desktop";

const primaryClass =
  "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90";
const buttonClass = "rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted";

function Setting({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 rounded bg-muted px-2 py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-2 font-medium">
        {value}
        {copy ? (
          <button
            type="button"
            className="rounded border px-1.5 py-0.5 text-[11px] font-normal hover:bg-background"
            onClick={() => {
              navigator.clipboard
                ?.writeText(value)
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="space-y-1.5">
      <h6 className="text-xs font-medium">{title}</h6>
      {children}
    </li>
  );
}

const Why = ({ children }: { children: ReactNode }) => (
  <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
);

function Line({ kind, children }: { kind: "ok" | "no" | "warn"; children: ReactNode }) {
  const mark = { ok: "✓", no: "✕", warn: "!" }[kind];
  const color = {
    ok: "text-success",
    no: "text-destructive",
    warn: "text-amber-600 dark:text-amber-400",
  }[kind];
  return (
    <li className="grid grid-cols-[14px_minmax(0,1fr)] gap-1.5 text-xs leading-relaxed">
      <span aria-hidden="true" className={`text-center font-bold ${color}`}>
        {mark}
      </span>
      <span>{children}</span>
    </li>
  );
}

function CheckResult({ check }: { check: RobloxKeyCheck }) {
  if (check.result === "unreachable") {
    return <Line kind="no">Couldn't reach Roblox. Check your connection, then check again.</Line>;
  }
  if (check.result === "not_a_key") {
    return (
      <Line kind="no">
        Roblox doesn't recognize this key. Copy it again from Roblox, and make sure you got all of
        it.
      </Line>
    );
  }
  const owner = check.ownerName ?? `account ${check.ownerId}`;
  const studioName = check.studio ? (check.studio.name ?? `account ${check.studio.id}`) : null;
  return (
    <>
      {check.active ? (
        <Line kind="ok">The key works.</Line>
      ) : (
        <Line kind="no">
          This key is switched off. Roblox does that after 60 days without use. On Roblox, click
          Edit on this key and switch Enable Key off and back on.
        </Line>
      )}
      {check.canUpload ? (
        <Line kind="ok">It can add models: asset:read and asset:write.</Line>
      ) : (
        <Line kind="no">
          It can't add models yet. On Roblox, click Edit on this key, add read and write under
          assets, and save.
        </Line>
      )}
      {!check.studio ? (
        <Line kind="warn">
          It belongs to {owner}. Open your place in Studio to check that's the account you use
          there.
        </Line>
      ) : check.studio.id === check.ownerId ? (
        <Line kind="ok">It belongs to {owner}, the same account Studio is signed in to.</Line>
      ) : (
        <Line kind="no">
          It belongs to {owner}, but Studio is signed in to {studioName}. Models uploaded with this
          key won't load in your place. Make the key on the account you use in Studio, or switch
          Studio to this account.
        </Line>
      )}
      {check.reachesGroups ? (
        <Line kind="warn">
          It can reach every group you're in. On Roblox, click Edit on this key, turn on Restrict by
          Creator, and pick your own name.
        </Line>
      ) : null}
      {check.extraAccess.length > 0 ? (
        <Line kind="warn">
          It can also reach {check.extraAccess.join(", ")}, which BloxBot doesn't need. Remove that
          on Roblox to keep the key safer.
        </Line>
      ) : null}
    </>
  );
}

function KeyGuide({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const studioKey = useStudioTargetOptional()?.selected?.key ?? null;
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<RobloxKeyCheck | null>(null);

  const runCheck = useMutation<RobloxKeyCheck, Error>({
    mutationFn: () => desktop.checkRobloxKey(key.trim(), studioKey),
    onSuccess: (next) => {
      setCheck(next);
      posthog.capture(
        "roblox_key_checked",
        analyticsProperties("three_d_tools", {
          outcome: next.result,
          can_upload: next.result === "checked" ? next.canUpload : undefined,
          reaches_groups: next.result === "checked" ? next.reachesGroups : undefined,
          same_account:
            next.result === "checked" && next.studio ? next.studio.id === next.ownerId : undefined,
        }),
      );
    },
    onError: () => setCheck({ result: "unreachable" }),
  });
  const turnOn = useMutation<void, Error>({
    mutationFn: () => desktop.saveRobloxKey(key.trim()),
    onSuccess: () => {
      setKey("");
      posthog.capture("roblox_uploads_turned_on", analyticsProperties("three_d_tools"));
      notify.success("Uploads are on");
      void queryClient.invalidateQueries({ queryKey: qk.robloxUpload });
    },
    onError: () =>
      notify.error("Couldn't save the key", {
        description: "Check the key again, then try once more.",
      }),
  });

  const usable = check?.result === "checked" && check.active && check.canUpload;
  // Uploading would work, but the model could never load in the place.
  const wrongAccount =
    check?.result === "checked" && !!check.studio && check.studio.id !== check.ownerId;
  const hasWarning =
    check?.result === "checked" && (check.reachesGroups || check.extraAccess.length > 0);

  return (
    <div className="mt-3 space-y-4 border-t pt-3">
      <p className="text-xs leading-relaxed">
        You'll make a key on Roblox. A key is a password that only opens what you tick, so BloxBot
        can add models without ever having your Roblox password.
      </p>
      <ol className="list-decimal space-y-4 pl-4">
        <Step title="Open Roblox's API Keys page">
          <p className="text-xs">
            Sign in with the same account you use in Studio. The page is called API Extensions.
          </p>
          <button
            type="button"
            className={buttonClass}
            onClick={() => desktop.openUrl(ROBLOX_API_KEYS_URL).catch(() => {})}
          >
            Open API Keys page
          </button>
          <Why>
            If it says "You do not have permissions to generate API keys for this community", you're
            looking at a group. Click the name at the top left, choose your own name, marked You,
            and open the page again.
          </Why>
        </Step>
        <Step title="Click Create API Key and name it">
          <Setting label="Name" value="BloxBot" copy />
          <Why>
            Use a new key just for BloxBot. The name has to be unique, so add a number if you
            already have one called that.
          </Why>
        </Step>
        <Step title="Choose assets">
          <Setting label="Select API System" value="assets" />
          <Why>
            Type "asset" to find it. Pick exactly assets, not asset-permissions or legacy-assets.
            Don't add anything else.
          </Why>
        </Step>
        <Step title="Limit it to your own account">
          <Setting label="Restrict by Creator" value="On" />
          <Setting label="Search for a creator" value="Your own name" />
          <Why>
            Roblox asks if you're sure, so click Continue. Without this, the key also reaches the
            assets of every group you're in.
          </Why>
        </Step>
        <Step title="Add both operations">
          <Setting label="Select Operations to Add" value="read, then write" />
          <Why>
            The list closes after each pick, so open it twice. You should see asset:read and
            asset:write.
          </Why>
          <div className="grid gap-1.5 text-xs @lg:grid-cols-2">
            <div className="rounded border p-2">
              <p className="font-medium">What this key can do</p>
              <p className="mt-0.5 text-muted-foreground">
                Add and change models and other assets on your own account.
              </p>
            </div>
            <div className="rounded border p-2">
              <p className="font-medium">What it can't do</p>
              <p className="mt-0.5 text-muted-foreground">
                Reach your groups, publish your games or change your account.
              </p>
            </div>
          </div>
        </Step>
        <Step title="Leave Security as it is">
          <Setting label="Restrict which IP addresses" value="Off" />
          <Setting label="Expiration" value="No Expiration" />
          <Why>
            Your home internet address can change, and a restricted key would stop working. With
            this off, anyone holding the key can upload in your name, so treat it like a password.
            If it ever leaks, delete it on the same Roblox page.
          </Why>
        </Step>
        <Step title="Copy the key and paste it here">
          <p className="text-xs leading-relaxed">
            Click Save &amp; Generate Key, then copy what Roblox shows you. Paste it only here,
            never into a chat. It's stored encrypted on this computer, and the AI can't see it.
          </p>
          <label htmlFor="roblox-api-key" className="block text-xs font-medium">
            API key
          </label>
          <input
            id="roblox-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setCheck(null);
            }}
            className="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs"
          />
          {check ? (
            <ul aria-live="polite" className="space-y-1">
              <CheckResult check={check} />
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={usable && !wrongAccount ? buttonClass : primaryClass}
              aria-disabled={!key.trim() || runCheck.isPending}
              onClick={() => {
                if (key.trim() && !runCheck.isPending) runCheck.mutate();
              }}
            >
              {runCheck.isPending ? "Checking" : check ? "Check again" : "Check key"}
            </button>
            {usable && !wrongAccount ? (
              <button
                type="button"
                className={primaryClass}
                aria-disabled={turnOn.isPending}
                onClick={() => {
                  if (!turnOn.isPending) turnOn.mutate();
                }}
              >
                {hasWarning ? "Use it anyway" : "Turn on uploads"}
              </button>
            ) : null}
          </div>
        </Step>
      </ol>
      <button
        type="button"
        className="text-xs underline underline-offset-2 hover:text-foreground"
        onClick={onClose}
      >
        Not now
      </button>
    </div>
  );
}

/** Off for everyone until they ask, because importing by hand needs no key. */
export function RobloxUploadsCard({ startOpen = false }: { startOpen?: boolean }) {
  const queryClient = useQueryClient();
  const [guideOpen, setGuideOpen] = useState(startOpen);
  const { data: state } = useQuery({
    queryKey: qk.robloxUpload,
    queryFn: () => desktop.getRobloxUploadState(),
  });
  const turnOff = useMutation<void, Error>({
    mutationFn: () => desktop.forgetRobloxKey(),
    onSuccess: () => {
      setGuideOpen(false);
      posthog.capture("roblox_uploads_turned_off", analyticsProperties("three_d_tools"));
      void queryClient.invalidateQueries({ queryKey: qk.robloxUpload });
    },
    onError: () => notify.error("Couldn't forget the key", { description: "Try again." }),
  });
  if (!state) return null;

  return (
    <div className="rounded-lg border bg-card p-3 @container">
      <p className="text-sm font-medium">Upload to Roblox</p>
      {state.state === "unavailable" ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          This computer can't store a key safely, so import models through Studio instead.
        </p>
      ) : state.state === "on" ? (
        <>
          <output className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            On. Models upload to {state.ownerName ?? `account ${state.ownerId}`} after you click
            Upload on each one.
          </output>
          <button
            type="button"
            className="mt-2 text-xs underline underline-offset-2 hover:text-foreground"
            onClick={() => turnOff.mutate()}
          >
            Turn off and forget the key
          </button>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            That only removes it from BloxBot, so delete it on Roblox too.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Off. You import models through Studio. Turn this on to add them with one click, after
            you check each one.
          </p>
          {guideOpen ? (
            <KeyGuide onClose={() => setGuideOpen(false)} />
          ) : (
            <button
              type="button"
              className={`${buttonClass} mt-2`}
              onClick={() => setGuideOpen(true)}
            >
              Set up uploads
            </button>
          )}
        </>
      )}
    </div>
  );
}
