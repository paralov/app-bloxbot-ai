import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { toast } from "sonner";

interface LegacyPluginBannerProps {
  onDismiss: () => void;
}

function LegacyPluginBanner({ onDismiss }: LegacyPluginBannerProps) {
  const [removing, setRemoving] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    try {
      await invoke("remove_legacy_plugin");
      toast.success("Old MCP plugin removed");
      onDismiss();
    } catch (err) {
      toast.error("Failed to remove the old plugin. Try deleting it manually.");
      console.error("remove_legacy_plugin failed:", err);
      setRemoving(false);
    }
  }

  return (
    <div className="animate-fade-in border-b border-amber-200/60 bg-amber-50/50 px-3 py-1.5">
      <div className="flex items-center gap-3">
        {/* Amber dot */}
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />

        {/* Message */}
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-stone-600">
          <span className="font-medium text-stone-800">Old MCP plugin found</span>
          {" — "}
          you can remove it to avoid conflicts, or dismiss if you use it separately.
        </p>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing}
            className="rounded-md border border-amber-300/80 bg-amber-100/80 px-2 py-0.5 text-[10px] font-medium text-amber-800 transition-all hover:border-amber-400 hover:bg-amber-200/80 active:scale-[0.97] disabled:opacity-50"
          >
            {removing ? "Removing..." : "Remove"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded p-0.5 text-stone-400 transition-colors hover:text-stone-600"
            aria-label="Dismiss"
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default LegacyPluginBanner;
