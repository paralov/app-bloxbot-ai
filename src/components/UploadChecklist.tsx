import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { desktop } from "@/lib/desktop";
import type { UploadAccess } from "@/types/desktop";

const Strong = ({ children }: { children: ReactNode }) => (
  <b className="font-medium text-foreground">{children}</b>
);

/** Looks like the label people have to find in Studio's corner. */
const McpLabel = () => (
  <span className="inline-flex items-center gap-1 rounded bg-muted px-1 align-baseline font-medium text-foreground">
    <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
    MCP
  </span>
);

const OPEN_PERMISSIONS = (
  <>
    In Studio, click <McpLabel /> at the bottom right, then the <Strong>MCP Permissions</Strong>{" "}
    tab.
  </>
);

function FolderRow({ access }: { access: UploadAccess }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 rounded-md bg-muted p-2">
      <p className="break-all font-mono text-xs text-foreground">{access.folder}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          className="rounded border px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
          onClick={() => {
            navigator.clipboard
              ?.writeText(access.folder)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy path"}
        </button>
        <button
          type="button"
          className="rounded border px-1.5 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
          onClick={() => desktop.openUrl(access.folderUrl).catch(() => {})}
        >
          Show folder
        </button>
      </div>
    </div>
  );
}

interface Step {
  id: string;
  title: string;
  done: boolean;
  how: ReactNode;
}

/** Only what's still to do has instructions, and the first of those is the one to do now. */
export function buildUploadSteps(access: UploadAccess, folderRefused = false): Step[] {
  const { state } = access;
  const hasStudio = state !== "no_studio" && state !== "choose_studio";
  const published = hasStudio && state !== "not_published";
  const upToDate = published && state !== "reopen_studio";
  return [
    state === "choose_studio"
      ? {
          id: "choose",
          title: "Choose your place",
          done: false,
          how: "More than one place is open. Choose yours in the Studio picker at the top of the chat.",
        }
      : {
          id: "studio",
          title: "Open your place in Studio",
          done: hasStudio,
          how: "Open the place you're building, and BloxBot will find it.",
        },
    {
      id: "published",
      title: "Publish your place",
      done: published,
      how: (
        <>
          In Studio, open the <Strong>File</Strong> menu and choose{" "}
          <Strong>Publish to Roblox</Strong>. Studio saves these permissions per game, so a place
          that isn't published can't have them.
        </>
      ),
    },
    ...(state === "reopen_studio"
      ? [
          {
            id: "reopen",
            title: "Reopen your place",
            done: false,
            how: "Close this place in Studio and open it again. It was open before Roblox's latest update, and doesn't have uploads until it's reopened.",
          },
        ]
      : []),
    {
      id: "read",
      title: "Allow asset:read",
      done: upToDate && access.readOn,
      how: (
        <>
          {OPEN_PERMISSIONS} Under <Strong>Publish &amp; manage assets</Strong>, open its
          capabilities and allow <Strong>asset:read</Strong>. It lets BloxBot see when an upload has
          finished.
        </>
      ),
    },
    {
      id: "write",
      title: "Allow asset:write",
      done: upToDate && access.writeOn,
      how: (
        <>
          {access.readOn ? (
            "Just below it, "
          ) : (
            <>
              {OPEN_PERMISSIONS} Under <Strong>Publish &amp; manage assets</Strong>,{" "}
            </>
          )}
          allow <Strong>asset:write</Strong>. It lets BloxBot upload a model when you press Upload.
        </>
      ),
    },
    state === "folder_unwritable"
      ? {
          id: "folder",
          title: "Let BloxBot save in the models folder",
          done: false,
          how: "Uploads send a copy saved next to the model, and BloxBot can't save in this folder. Allow changes to it:",
        }
      : {
          id: "folder",
          title: "Approve the models folder",
          done: state === "ready" && !folderRefused,
          how: (
            <>
              Further down <Strong>MCP Permissions</Strong>, under <Strong>Upload folders</Strong>,
              add this folder:
            </>
          ),
        },
  ];
}

/**
 * Only Studio can grant these, so BloxBot can't do them for someone. What it can do is watch, tick
 * each one off as it happens, and always show the very next thing to click.
 */
export function UploadChecklist({
  access,
  folderRefused,
}: {
  access: UploadAccess;
  folderRefused?: boolean;
}) {
  const steps = buildUploadSteps(access, folderRefused);
  const currentId = steps.find((step) => !step.done)?.id;
  return (
    <div>
      <ol className="space-y-1.5 text-xs">
        {steps.map((step, index) => {
          const current = step.id === currentId;
          return (
            <li key={step.id} aria-current={current ? "step" : undefined} className="flex gap-2">
              <span
                aria-hidden="true"
                className={`mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-medium tabular-nums ${
                  step.done
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : current
                      ? "bg-foreground text-background"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {step.done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : index + 1}
              </span>
              <div className="min-w-0 flex-1 leading-relaxed">
                <span className={current ? "font-medium text-foreground" : "text-muted-foreground"}>
                  {step.title}
                  {step.done ? <span className="sr-only"> (done)</span> : null}
                </span>
                {current ? (
                  <div className="mt-0.5 text-muted-foreground">
                    {step.how}
                    {step.id === "folder" ? <FolderRow access={access} /> : null}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <output className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60 motion-reduce:animate-none"
        />
        Watching Studio. These tick off as you go.
      </output>
    </div>
  );
}
