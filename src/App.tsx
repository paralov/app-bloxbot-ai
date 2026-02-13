import { useEffect, useState } from "react";

import Chat from "@/components/Chat";
import ConnectionBanner from "@/components/ConnectionBanner";
import ErrorBoundary from "@/components/ErrorBoundary";
import LegacyPluginBanner from "@/components/LegacyPluginBanner";
import OpenCodeProvider from "@/components/OpenCodeProvider";
import StudioStatus from "@/components/StudioStatus";
import UpdateBanner from "@/components/UpdateBanner";
import { Toaster } from "@/components/ui/sonner";
import { useUpdater } from "@/hooks/useUpdater";
import { capture } from "@/lib/telemetry";
import { useStore } from "@/stores/opencode";

function App() {
  const { status, pendingUpdate, installUpdate, dismissUpdate } = useUpdater();
  const legacyPluginExists = useStore((s) => s.legacyPluginExists);
  const [legacyDismissed, setLegacyDismissed] = useState(false);

  useEffect(() => {
    capture("app_launched");
  }, []);

  return (
    <OpenCodeProvider>
      <main className="flex h-full flex-col overflow-hidden">
        {/* Title bar drag region */}
        <div
          className="flex h-9 shrink-0 items-center justify-end border-b bg-card px-3"
          data-tauri-drag-region
        >
          <StudioStatus />
        </div>
        {pendingUpdate && (
          <UpdateBanner
            status={status}
            update={pendingUpdate}
            onInstall={installUpdate}
            onDismiss={dismissUpdate}
          />
        )}
        {legacyPluginExists && !legacyDismissed && (
          <LegacyPluginBanner onDismiss={() => setLegacyDismissed(true)} />
        )}
        <ErrorBoundary>
          <Chat />
        </ErrorBoundary>
        <ConnectionBanner />
        <Toaster />
      </main>
    </OpenCodeProvider>
  );
}

export default App;
