import { useEffect } from "react";
import Chat from "@/components/Chat";
import OpenCodeProvider from "@/components/OpenCodeProvider";
import StudioStatus from "@/components/StudioStatus";
import { Toaster } from "@/components/ui/sonner";
import { capture } from "@/lib/telemetry";

function App() {
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
        <Chat />
        <Toaster />
      </main>
    </OpenCodeProvider>
  );
}

export default App;
