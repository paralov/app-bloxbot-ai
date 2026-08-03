import { useRef } from "react";

import Chat from "@/components/Chat";
import ErrorBoundary from "@/components/ErrorBoundary";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { useUpdater } from "@/hooks/useUpdater";
import { ActiveSessionProvider } from "@/providers/ActiveSessionProvider";
import { ExplorerReferenceProvider } from "@/providers/ExplorerReferenceProvider";
import { OpenCodeClientProvider } from "@/providers/OpenCodeClientProvider";
import { PreferencesProvider } from "@/providers/PreferencesProvider";
import { QueryProvider } from "@/providers/QueryProvider";
import { StudioTargetProvider } from "@/providers/StudioTargetProvider";
import { TelemetryProvider } from "@/providers/TelemetryProvider";

function AppInner() {
  useUpdater();

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <div className="app-titlebar flex h-9 shrink-0 items-center justify-end border-b bg-card px-3" />
      <ErrorBoundary>
        <Chat />
      </ErrorBoundary>
      <Toaster />
    </main>
  );
}

function App() {
  const activeSessionIdRef = useRef<string | null>(null);

  return (
    <QueryProvider>
      <TelemetryProvider>
        <ThemeProvider>
          <OpenCodeClientProvider activeSessionIdRef={activeSessionIdRef}>
            <ActiveSessionProvider activeSessionIdRef={activeSessionIdRef}>
              <PreferencesProvider>
                <StudioTargetProvider>
                  <ExplorerReferenceProvider>
                    <AppInner />
                  </ExplorerReferenceProvider>
                </StudioTargetProvider>
              </PreferencesProvider>
            </ActiveSessionProvider>
          </OpenCodeClientProvider>
        </ThemeProvider>
      </TelemetryProvider>
    </QueryProvider>
  );
}

export default App;
