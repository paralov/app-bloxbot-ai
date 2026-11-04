import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronLeft, ExternalLink, X } from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { type ReactNode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { analyticsProperties } from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { notify } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import { ROBLOX_API_KEYS_URL } from "@/lib/robloxKeys";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { RobloxKeyCheck } from "@/types/desktop";

const primary =
  "rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90";
const secondary = "rounded-md border px-3 py-1.5 text-xs transition-colors hover:bg-accent";

/** What to pick on Roblox's form, under the same names the form uses. */
function Fields({ children }: { children: ReactNode }) {
  return <dl className="divide-y rounded-lg border bg-card">{children}</dl>;
}

function Field({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-xs font-medium text-foreground">
        {value}
        {copy ? (
          <button
            type="button"
            className="rounded border px-1.5 py-0.5 text-[11px] font-normal transition-colors hover:bg-accent"
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
      </dd>
    </div>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
);

const openKeysPage = () => desktop.openUrl(ROBLOX_API_KEYS_URL).catch(() => {});

interface Step {
  title: string;
  body: ReactNode;
}

const STEPS: Step[] = [
  {
    title: "Open Roblox's API Keys page",
    body: (
      <>
        <Note>
          A key lets BloxBot add models for you without your Roblox password. It only opens what you
          tick. Sign in with the same account you use in Studio.
        </Note>
        <div>
          <button
            type="button"
            className={`${primary} inline-flex items-center gap-1.5`}
            onClick={openKeysPage}
          >
            Open API Keys page
            <ExternalLink aria-hidden="true" className="h-3 w-3" />
          </button>
        </div>
        <details className="group text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            It says I don't have permission
          </summary>
          <p className="mt-1.5 leading-relaxed">
            You're looking at a group. Click the name at the top left, choose your own name, marked
            You, and open the page again.
          </p>
        </details>
      </>
    ),
  },
  {
    title: "Click Create API Key and name it",
    body: (
      <>
        <Fields>
          <Field label="Name" value="BloxBot" copy />
        </Fields>
        <Note>Make a new key just for BloxBot. If the name's taken, add a number.</Note>
      </>
    ),
  },
  {
    title: "Choose assets",
    body: (
      <>
        <Fields>
          <Field label="Select API System" value="assets" />
        </Fields>
        <Note>
          Type "asset" to find it. Pick exactly assets, not asset-permissions or legacy-assets.
          Don't add anything else.
        </Note>
      </>
    ),
  },
  {
    title: "Limit it to your account",
    body: (
      <>
        <Fields>
          <Field label="Restrict by Creator" value="On" />
          <Field label="Search for a creator" value="Your own name" />
        </Fields>
        <Note>
          Roblox asks if you're sure, so click Continue. Without this, the key also reaches the
          assets of every group you're in.
        </Note>
      </>
    ),
  },
  {
    title: "Add read and write",
    body: (
      <>
        <Fields>
          <Field label="Select Operations to Add" value="read, then write" />
        </Fields>
        <Note>
          The list closes after each pick, so open it twice. You should see asset:read and
          asset:write.
        </Note>
        <div className="divide-y rounded-lg border bg-card text-xs">
          <div className="px-3 py-2">
            <p className="font-medium">This key can</p>
            <p className="mt-0.5 text-muted-foreground">
              Add and change models on your own account.
            </p>
          </div>
          <div className="px-3 py-2">
            <p className="font-medium">It can't</p>
            <p className="mt-0.5 text-muted-foreground">
              Reach your groups, publish your games or change your account.
            </p>
          </div>
        </div>
      </>
    ),
  },
  {
    title: "Save the key and copy it",
    body: (
      <>
        <Fields>
          <Field label="Restrict which IP addresses" value="Leave off" />
          <Field label="Expiration" value="No Expiration" />
        </Fields>
        <Note>
          These are already set. Click Save &amp; Generate Key, then copy what Roblox shows you.
          Anyone holding the key can upload in your name, so treat it like a password. If it ever
          leaks, delete it on the same Roblox page.
        </Note>
      </>
    ),
  },
];

function Result({ kind, children }: { kind: "ok" | "no" | "warn"; children: ReactNode }) {
  const Icon = { ok: Check, no: X, warn: AlertTriangle }[kind];
  const color = {
    ok: "text-emerald-600 dark:text-emerald-400",
    no: "text-red-600 dark:text-red-400",
    warn: "text-amber-600 dark:text-amber-400",
  }[kind];
  return (
    <li className="flex items-start gap-2 px-3 py-2 text-xs leading-relaxed">
      <Icon aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 flex-none ${color}`} />
      <span>{children}</span>
    </li>
  );
}

function CheckResults({ check }: { check: RobloxKeyCheck }) {
  if (check.result === "unreachable") {
    return (
      <Result kind="no">Couldn't reach Roblox. Check your connection, then check again.</Result>
    );
  }
  if (check.result === "not_a_key") {
    return (
      <Result kind="no">
        Roblox doesn't recognize this key. Copy it again from Roblox, and make sure you got all of
        it.
      </Result>
    );
  }
  const owner = check.ownerName ?? `account ${check.ownerId}`;
  const studioName = check.studio ? (check.studio.name ?? `account ${check.studio.id}`) : null;
  return (
    <>
      {check.active ? (
        <Result kind="ok">The key works.</Result>
      ) : (
        <Result kind="no">
          This key is switched off. Roblox does that after 60 days without use. On Roblox, click
          Edit on this key and switch Enable Key off and back on.
        </Result>
      )}
      {check.canUpload ? (
        <Result kind="ok">It can add models.</Result>
      ) : (
        <Result kind="no">
          It can't add models yet. On Roblox, click Edit on this key, add read and write under
          assets, and save.
        </Result>
      )}
      {!check.studio ? (
        <Result kind="warn">
          It belongs to {owner}. Make sure that's the account you use in Studio. BloxBot checks
          again before each upload.
        </Result>
      ) : check.studio.id === check.ownerId ? (
        <Result kind="ok">It belongs to {owner}, the same account Studio is signed in to.</Result>
      ) : (
        <Result kind="no">
          It belongs to {owner}, but Studio is signed in to {studioName}. Models uploaded with this
          key won't load in your place. Make the key on the account you use in Studio, or switch
          Studio to this account.
        </Result>
      )}
      {check.reachesGroups ? (
        <Result kind="warn">
          It can reach every group you're in. On Roblox, click Edit on this key, turn on Restrict by
          Creator, and pick your own name.
        </Result>
      ) : null}
      {check.extraAccess.length > 0 ? (
        <Result kind="warn">
          It can also reach {check.extraAccess.join(", ")}, which BloxBot doesn't need. Remove that
          on Roblox to keep the key safer.
        </Result>
      ) : null}
    </>
  );
}

/** One step at a time, because Roblox's form is in another window and people look back and forth. */
export function RobloxKeyWizard({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const studioKey = useStudioTargetOptional()?.selected?.key ?? null;
  const [stepIndex, setStepIndex] = useState(0);
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<RobloxKeyCheck | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const total = STEPS.length + 1;
  const onPaste = stepIndex === STEPS.length;

  const goTo = (index: number) => {
    flushSync(() => setStepIndex(index));
    headingRef.current?.focus();
  };

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
    onSuccess: async () => {
      posthog.capture("roblox_uploads_turned_on", analyticsProperties("three_d_tools"));
      notify.success("Uploads are on");
      await queryClient.invalidateQueries({ queryKey: qk.robloxUpload });
      onClose();
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
  const canTurnOn = usable && !wrongAccount;

  return (
    <div className="mx-auto w-full max-w-md px-4 py-6 @xl:px-6 @xl:py-8">
      <button
        type="button"
        onClick={onClose}
        className="-ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
        3D tools
      </button>
      <h4 className="mt-3 text-lg font-medium text-foreground">Connect Roblox</h4>

      <div className="mt-4 flex items-center gap-3">
        <div aria-hidden="true" className="flex flex-1 gap-1">
          {Array.from({ length: total }, (_, index) => (
            <div
              key={index}
              className={`h-1 flex-1 rounded-full transition-colors ${index <= stepIndex ? "bg-foreground/70" : "bg-muted"}`}
            />
          ))}
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          Step {stepIndex + 1} of {total}
        </span>
      </div>

      <h5
        ref={headingRef}
        tabIndex={-1}
        className="mt-5 text-sm font-medium text-foreground outline-none"
      >
        {onPaste ? "Paste the key here" : STEPS[stepIndex]?.title}
      </h5>

      <div className="mt-2 space-y-3">
        {onPaste ? (
          <>
            <Note>
              Paste it only here, never into a chat. It's stored encrypted on this computer, and the
              AI can't see it.
            </Note>
            <div>
              <label htmlFor="roblox-api-key" className="sr-only">
                API key
              </label>
              <input
                id="roblox-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Your API key"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setCheck(null);
                }}
                className="h-8 w-full rounded-md border bg-transparent px-2.5 font-mono text-xs placeholder:font-sans placeholder:text-muted-foreground/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            {check ? (
              <ul aria-live="polite" className="divide-y rounded-lg border bg-card">
                <CheckResults check={check} />
              </ul>
            ) : null}
          </>
        ) : (
          STEPS[stepIndex]?.body
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        {stepIndex > 0 ? (
          <button type="button" className={secondary} onClick={() => goTo(stepIndex - 1)}>
            Back
          </button>
        ) : (
          <span />
        )}
        {onPaste ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            <button
              type="button"
              className={canTurnOn ? secondary : primary}
              aria-disabled={!key.trim() || runCheck.isPending}
              onClick={() => {
                if (key.trim() && !runCheck.isPending) runCheck.mutate();
              }}
            >
              {runCheck.isPending ? "Checking" : check ? "Check again" : "Check key"}
            </button>
            {canTurnOn ? (
              <button
                type="button"
                className={primary}
                aria-disabled={turnOn.isPending}
                onClick={() => {
                  if (!turnOn.isPending) turnOn.mutate();
                }}
              >
                {hasWarning ? "Use it anyway" : "Turn on uploads"}
              </button>
            ) : null}
          </div>
        ) : (
          <button type="button" className={primary} onClick={() => goTo(stepIndex + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
