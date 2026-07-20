import { useState } from "react";

const STEPS = [
  {
    title: "Open a place",
    description: "Open any place in Roblox Studio.",
  },
  {
    title: "Assistant",
    description: "Click Assistant in the top-right corner.",
  },
  {
    title: "Manage MCP Servers",
    description: "Open the ••• menu, then click Manage MCP Servers.",
  },
  {
    title: "Enable Studio as MCP server",
    description: "Turn on Enable Studio as MCP server.",
  },
] as const;

interface StudioSetupProps {
  connected: boolean;
  checking: boolean;
  onCheck: () => void;
  onContinue: () => void;
}

function StudioSetup({ connected, checking, onCheck, onContinue }: StudioSetupProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];

  if (connected) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-5">
        <section className="animate-scale-in flex max-w-md flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
            <svg
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m5 12 4 4L19 6" />
            </svg>
          </div>
          <h1 className="mt-5 font-serif text-3xl italic">Studio connected</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            BloxBot is in the driver&apos;s seat. You&apos;re ready to build.
          </p>
          <button
            type="button"
            onClick={onContinue}
            className="mt-6 inline-flex h-10 items-center rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Let&apos;s build
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-5">
      <section className="animate-fade-in-up w-full max-w-2xl" aria-labelledby="studio-setup-title">
        <header className="flex items-center gap-4">
          <BloxBotFace />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              One tiny setup
            </p>
            <h1 id="studio-setup-title" className="font-serif text-2xl italic">
              Let&apos;s connect Studio
            </h1>
          </div>
        </header>

        <div className="mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Step {stepIndex + 1} of {STEPS.length}
              </p>
              <h2 className="mt-0.5 text-base font-semibold">{step.title}</h2>
            </div>
            <div className="flex gap-1.5" aria-hidden="true">
              {STEPS.map((item, index) => (
                <span
                  key={item.title}
                  className={`h-1.5 rounded-full transition-all ${
                    index === stepIndex ? "w-6 bg-foreground" : "w-1.5 bg-foreground/15"
                  }`}
                />
              ))}
            </div>
          </div>

          <StudioIllustration step={stepIndex} />

          <div className="flex items-center justify-between gap-4 border-t px-5 py-3.5">
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              {step.description}
            </p>
            <div className="flex shrink-0 gap-2">
              {stepIndex > 0 && (
                <button
                  type="button"
                  onClick={() => setStepIndex((current) => current - 1)}
                  className="h-9 rounded-lg border px-4 text-xs font-medium transition-colors hover:bg-muted"
                >
                  Back
                </button>
              )}
              {stepIndex < STEPS.length - 1 ? (
                <button
                  type="button"
                  onClick={() => setStepIndex((current) => current + 1)}
                  className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition-opacity hover:opacity-90"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCheck}
                  disabled={checking}
                  className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {checking ? "Looking..." : "Check again"}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          Looking for Roblox Studio
        </div>
      </section>
    </div>
  );
}

function StudioIllustration({ step }: { step: number }) {
  return (
    <div
      className="studio-demo"
      role="img"
      aria-label={
        step === 0
          ? "A playful representation of an open Roblox Studio project"
          : step === 1
            ? "The Assistant window open in Roblox Studio"
            : step === 2
              ? "The Assistant menu zoomed in with Manage MCP Servers highlighted"
              : "Assistant Settings zoomed in with Enable Studio as MCP server turned on"
      }
    >
      <div key={step} className={`studio-demo-camera studio-demo-camera--${step}`}>
        <div className="studio-demo-window">
          <div className="studio-demo-toolbar">
            <div className="flex items-center gap-1.5">
              <span className="studio-demo-window-dot" />
              <span className="studio-demo-window-dot" />
              <span className="studio-demo-window-dot" />
            </div>
            <div className="studio-demo-tabs">
              <span className="studio-demo-tab studio-demo-tab--active">Home</span>
              <span>Avatar</span>
              <span>UI</span>
              <span>Script</span>
              <span>Model</span>
              <span>Plugins</span>
            </div>
            <div className="studio-demo-assistant-pill">
              <MiniFace />
              Assistant
            </div>
          </div>

          <div className="studio-demo-tools">
            {["Select", "Move", "Scale", "Rotate", "Part"].map((tool, index) => (
              <div key={tool} className="studio-demo-tool">
                <span className={`studio-demo-tool-icon studio-demo-tool-icon--${index}`} />
                {tool}
              </div>
            ))}
          </div>

          <div className="studio-demo-body">
            <aside className="studio-demo-sidebar">
              <p className="studio-demo-label">Explorer</p>
              {["Workspace", "Players", "Lighting", "StarterGui"].map((item, index) => (
                <div key={item} className="studio-demo-tree-row">
                  <span className={`studio-demo-tree-icon studio-demo-tree-icon--${index}`} />
                  {item}
                </div>
              ))}
            </aside>

            <div className="studio-demo-canvas">
              <div className="studio-demo-cloud studio-demo-cloud--one" />
              <div className="studio-demo-cloud studio-demo-cloud--two" />
              <div className="studio-demo-platform">
                <span className="studio-demo-block studio-demo-block--one" />
                <span className="studio-demo-block studio-demo-block--two" />
                <span className="studio-demo-block studio-demo-block--three" />
                <span className="studio-demo-block studio-demo-block--four" />
              </div>
              <div className="studio-demo-axis">Y</div>
            </div>

            <aside className="studio-demo-properties">
              <p className="studio-demo-label">Properties</p>
              <div className="studio-demo-property" />
              <div className="studio-demo-property studio-demo-property--short" />
              <div className="studio-demo-property" />
            </aside>
          </div>

          {step >= 1 && step < 3 && (
            <div className="studio-demo-assistant">
              <div className="studio-demo-assistant-header">
                <span>
                  New chat <i aria-hidden="true">⌄</i>
                </span>
                <span className="studio-demo-more">•••</span>
              </div>
              <div className="studio-demo-chat-bubble">Hi there! What can I help you build?</div>
              <div className="studio-demo-prompt">Ask Assistant</div>
              {step === 2 && (
                <div className="studio-demo-menu">
                  <div>Manage API Keys</div>
                  <div className="studio-demo-menu-subtle">
                    Roblox Default <span aria-hidden="true">›</span>
                  </div>
                  <div className="studio-demo-menu-active">
                    <span className="studio-demo-plug">⌁</span>
                    Manage MCP Servers
                  </div>
                  <div>Manage Skills</div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="studio-demo-settings">
              <div className="studio-demo-settings-title">Assistant Settings</div>
              <div className="studio-demo-settings-nav">
                <span>API Keys</span>
                <strong>MCP Servers</strong>
                <span>Skills</span>
              </div>
              <div className="studio-demo-settings-content">
                <div className="studio-demo-settings-notice">
                  Connecting a third-party LLM to Roblox Studio shares your data with that provider.
                  Review their privacy practices, terms, and age limits before proceeding. Roblox is
                  not responsible for third-party model output.
                </div>
                <div className="studio-demo-switch-row">
                  <div>
                    <strong>Enable Studio as MCP server</strong>
                    <span>
                      <i aria-hidden="true">●</i> No clients connected
                    </span>
                  </div>
                  <span className="studio-demo-switch">
                    <span />
                  </span>
                </div>
                <div className="studio-demo-quick-connect">
                  <span aria-hidden="true">⌄</span>&nbsp;&nbsp; Quick connect
                </div>
                <div className="studio-demo-client-row">
                  <span>Claude Code CLI</span>
                  <span>›</span>
                </div>
                <div className="studio-demo-client-row">
                  <span>Codex</span>
                  <span className="studio-demo-small-switch" />
                </div>
                <div className="studio-demo-client-row">
                  <span>Cursor</span>
                  <span className="studio-demo-small-switch" />
                </div>
                <div className="studio-demo-client-row">
                  <span>Gemini CLI</span>
                  <span>›</span>
                </div>
                <div className="studio-demo-setup-instructions">
                  <span aria-hidden="true">›</span>&nbsp;&nbsp; Setup Instructions
                </div>
                <div className="studio-demo-documentation">
                  For detailed instructions see documentation
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div key={`focus-${step}`} className={`studio-demo-focus studio-demo-focus--${step}`} />
    </div>
  );
}

function MiniFace() {
  return (
    <span className="studio-demo-face" aria-hidden="true">
      <i />
      <i />
      <b />
    </span>
  );
}

function BloxBotFace() {
  return (
    <svg
      width="52"
      height="52"
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="bloxbot-face shrink-0"
      aria-hidden="true"
    >
      <rect x="32" y="32" width="448" height="448" rx="112" fill="currentColor" />
      <rect
        className="bloxbot-eye"
        x="144"
        y="176"
        width="72"
        height="72"
        rx="24"
        fill="var(--background)"
      />
      <rect
        className="bloxbot-eye"
        x="296"
        y="176"
        width="72"
        height="72"
        rx="24"
        fill="var(--background)"
      />
      <path
        d="M168 328C168 328 204.8 376 256 376C307.2 376 344 328 344 328"
        stroke="var(--background)"
        strokeWidth="32"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default StudioSetup;
