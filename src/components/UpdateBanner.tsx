import type { UpdateInfo, UpdaterStatus } from "@/hooks/useUpdater";

interface UpdateBannerProps {
  status: UpdaterStatus;
  update: UpdateInfo;
  onInstall: () => void;
  onDismiss: () => void;
}

function UpdateBanner({ status, update, onInstall, onDismiss }: UpdateBannerProps) {
  const downloading = status === "downloading";

  return (
    <div className="animate-fade-in-up border-b bg-primary px-4 py-2.5 text-primary-foreground">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">BloxBot {update.version} is available</p>
          {update.body && <p className="mt-0.5 truncate text-xs opacity-80">{update.body}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onInstall}
            disabled={downloading}
            className="rounded-md bg-primary-foreground px-3 py-1 text-xs font-medium text-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {downloading ? "Installing..." : "Install & Restart"}
          </button>

          {!downloading && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
              aria-label="Dismiss update"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default UpdateBanner;
