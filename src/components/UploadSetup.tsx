import { useState } from "react";

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

/** Only Studio can grant these, so this says exactly where to go. It's the same on the card and in Settings. */
export function UploadSetup({ folder, onlyFolder }: { folder: string; onlyFolder?: boolean }) {
  return (
    <ol className="space-y-2 text-xs">
      {onlyFolder ? null : (
        <>
          <Step number={1}>
            In Studio, click <b className="font-medium">MCP</b> at the bottom right, then{" "}
            <b className="font-medium">MCP Permissions</b>.
          </Step>
          <Step number={2}>
            Under <b className="font-medium">Publish &amp; manage assets</b>, turn on{" "}
            <code className="font-mono">asset:read</code> and{" "}
            <code className="font-mono">asset:write</code>.
          </Step>
        </>
      )}
      <Step number={onlyFolder ? undefined : 3}>
        <span className="block">
          {onlyFolder ? "In Studio's MCP Permissions, approve" : "Under"}{" "}
          {onlyFolder ? (
            "this upload folder:"
          ) : (
            <>
              <b className="font-medium">Upload folders</b>, add this one:
            </>
          )}
        </span>
        <span className="mt-1 flex items-center gap-2 rounded-md bg-muted px-2 py-1 font-mono">
          <span className="min-w-0 flex-1 break-all">{folder}</span>
          <CopyPath path={folder} />
        </span>
      </Step>
    </ol>
  );
}

function Step({ number, children }: { number?: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      {number ? (
        <span
          aria-hidden="true"
          className="flex h-4 w-4 flex-none items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground"
        >
          {number}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 leading-relaxed">{children}</span>
    </li>
  );
}
