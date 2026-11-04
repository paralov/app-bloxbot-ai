import { Box, FileText, Globe, type LucideIcon, Pencil, Terminal, Upload } from "lucide-react";
import { memo } from "react";
import type { PermissionRequest } from "@/lib/opencode/types";
import { STUDIO_MCP_SERVER_NAME } from "@/lib/studioMcp";

interface Description {
  title: string;
  detail?: string;
  icon: LucideIcon;
  /** Can't be approved for good, because each one is a separate decision. */
  everyTime?: boolean;
  allow?: string;
  deny?: string;
}

const BUILT_IN: Record<string, Description> = {
  shell: { title: "Run this command?", icon: Terminal },
  bash: { title: "Run this command?", icon: Terminal },
  edit: { title: "Change this file?", icon: Pencil },
  write: { title: "Write this file?", icon: Pencil },
  read: { title: "Read this file?", icon: FileText },
  webfetch: { title: "Open this page?", icon: Globe },
  websearch: { title: "Search the web for this?", icon: Globe },
};

const words = (name: string) => name.replace(/[_-]+/g, " ").trim();

export function describePermission(permission: string): Description {
  if (permission.endsWith("upload_image")) {
    return {
      title: "Upload images to your Roblox account?",
      detail:
        "Roblox holds you responsible for what's uploaded. Only allow this for images you've checked.",
      icon: Upload,
      everyTime: true,
      allow: "Upload",
      deny: "Don't upload",
    };
  }
  const builtIn = BUILT_IN[permission];
  if (builtIn) return builtIn;
  for (const [prefix, app] of [
    [`${STUDIO_MCP_SERVER_NAME}_`, "Roblox Studio"],
    ["roblox_studio_", "Roblox Studio"],
    ["blender_", "Blender"],
  ]) {
    if (permission.startsWith(prefix)) {
      return { title: `Let ${app} ${words(permission.slice(prefix.length))}?`, icon: Box };
    }
  }
  return { title: `Allow ${words(permission)}?`, icon: Box };
}

export const PermissionPrompt = memo(function PermissionPrompt({
  permission,
  onReply,
}: {
  permission: PermissionRequest;
  onReply: (requestID: string, reply: "once" | "always" | "reject") => void;
}) {
  const {
    title,
    detail,
    icon: Icon,
    everyTime,
    allow,
    deny,
  } = describePermission(permission.permission);
  // A lone * means "everything", which says nothing to the person being asked.
  const targets = permission.patterns.filter((pattern) => pattern !== "*");

  return (
    <section
      aria-label="BloxBot needs your permission"
      className="animate-fade-in-up my-2 rounded-lg border bg-card p-3"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-muted">
          <Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {detail ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{detail}</p>
          ) : null}
          {targets.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {targets.map((target) => (
                <li
                  key={target}
                  className="overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground"
                >
                  {target}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-1.5">
        <button
          type="button"
          onClick={() => onReply(permission.id, "reject")}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {deny ?? "Deny"}
        </button>
        {everyTime ? null : (
          <button
            type="button"
            onClick={() => onReply(permission.id, "always")}
            className="rounded-md border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            Always allow
          </button>
        )}
        <button
          type="button"
          onClick={() => onReply(permission.id, "once")}
          className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          {allow ?? "Allow once"}
        </button>
      </div>
    </section>
  );
});
