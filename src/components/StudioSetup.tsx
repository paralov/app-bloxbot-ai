import { useState } from "react";

import findMcpImage from "@/assets/studio-setup/find-mcp.jpg";
import flipSwitchImage from "@/assets/studio-setup/flip-switch.jpg";
import openPlaceImage from "@/assets/studio-setup/open-place.jpg";

const STEPS = [
  {
    title: "Open a place",
    description: "Open any project in Roblox Studio.",
    image: openPlaceImage,
    alt: "An open place in Roblox Studio",
  },
  {
    title: "Find MCP Servers",
    description: "Open Assistant, tap the three dots, then choose Manage MCP Servers.",
    image: findMcpImage,
    alt: "The Manage MCP Servers option in Roblox Studio Assistant",
  },
  {
    title: "Flip the switch",
    description: "Turn on Studio as MCP server. BloxBot will spot it automatically.",
    image: flipSwitchImage,
    alt: "The Studio as MCP server switch turned on",
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

          <img
            key={step.image}
            src={step.image}
            alt={step.alt}
            className="animate-fade-in aspect-[16/9] w-full object-cover object-top"
          />

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
