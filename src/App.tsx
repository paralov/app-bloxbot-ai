import Chat from "@/components/Chat";
import OpenCodeProvider from "@/components/OpenCodeProvider";
import StudioStatus from "@/components/StudioStatus";
import { Toaster } from "@/components/ui/sonner";
import { useStore } from "@/stores/opencode";

function App() {
  const ready = useStore((s) => s.ready);

  return (
    <OpenCodeProvider>
      <main className="flex h-full flex-col overflow-hidden">
        {/* Title bar drag region */}
        <div
          className="relative flex h-9 shrink-0 items-center border-b bg-card"
          data-tauri-drag-region
        >
          {ready && (
            <div className="absolute right-2 top-1/2 z-10 -translate-y-1/2">
              <StudioStatus />
            </div>
          )}
        </div>
        <Chat />
        <Toaster />
      </main>
    </OpenCodeProvider>
  );
}

export default App;
