import { useState } from "react";
import { useStore } from "@/stores/opencode";

function ChatSetup() {
  const dismissWelcome = useStore((s) => s.dismissWelcome);
  const pluginInstalled = useStore((s) => s.pluginInstalled);
  const installPlugin = useStore((s) => s.installPlugin);

  const [step, setStep] = useState<"welcome" | "plugin">("welcome");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);

  async function handleInstall() {
    setInstalling(true);
    setInstallError(null);
    try {
      await installPlugin();
      setJustInstalled(true);
    } catch (err) {
      setInstallError(typeof err === "string" ? err : String(err));
    } finally {
      setInstalling(false);
    }
  }

  // ── Step 1: Welcome ────────────────────────────────────────────────
  if (step === "welcome") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="animate-fade-in-up flex w-full max-w-sm flex-col items-center text-center">
          <img src="/bloxbot-logo.svg" alt="" className="mx-auto h-14 w-14" />
          <p className="mt-3 font-serif text-lg italic text-foreground">bloxbot</p>

          <h2 className="mt-8 font-serif text-4xl italic text-foreground">Ready to build?</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Your AI co-pilot for Roblox Studio is warming up in the background.
          </p>

          <button
            onClick={() => setStep("plugin")}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Get Started
          </button>
        </div>
      </div>
    );
  }

  // ── Step 2: Plugin install ─────────────────────────────────────────
  const isInstalled = pluginInstalled || justInstalled;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="animate-fade-in-up w-full max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-stone-100">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-stone-500"
          >
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        </div>

        <h2 className="mt-6 font-serif text-2xl italic text-foreground">Studio Plugin</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          BloxBot needs a small plugin installed in Roblox Studio so it can read and write to your
          place files.
        </p>

        {isInstalled ? (
          <>
            <div className="mt-5 flex items-center justify-center gap-2 text-sm text-emerald-600">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Plugin installed
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Open Roblox Studio, go to the <strong>Plugins</strong> tab, open the MCP plugin
              window, and click <strong>Connect</strong>.
            </p>
            <button
              onClick={dismissWelcome}
              className="mt-5 inline-flex h-10 items-center justify-center rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
            >
              Continue
            </button>
          </>
        ) : (
          <>
            <button
              onClick={handleInstall}
              disabled={installing}
              className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {installing ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                  </svg>
                  Installing...
                </>
              ) : (
                "Install Plugin"
              )}
            </button>

            {installError && (
              <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
                {installError}
              </p>
            )}

            <button
              onClick={dismissWelcome}
              className="mt-3 text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Skip for now
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default ChatSetup;
