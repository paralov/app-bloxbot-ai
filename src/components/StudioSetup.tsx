import { useEffect, useRef, useState } from "react";

import findMcpImage from "@/assets/studio-setup/find-mcp.jpg";
import flipSwitchImage from "@/assets/studio-setup/flip-switch.jpg";
import openAssistantImage from "@/assets/studio-setup/open-assistant.jpg";
import openPlaceImage from "@/assets/studio-setup/open-place.jpg";
import type { StudioMcpProblem } from "@/hooks/useStudioConnection";

export const STUDIO_SETUP_STEPS = [
  {
    title: "Open a place",
    description: "Open any place in Roblox Studio.",
    image: openPlaceImage,
    alt: "The Baseplate template on the Roblox Studio home screen",
  },
  {
    title: "Assistant",
    description: "Click Assistant in the top-right corner.",
    image: openAssistantImage,
    alt: "An open Roblox Studio place with the Assistant button in the top-right corner",
  },
  {
    title: "Manage MCP Servers",
    description: "Open the ••• menu, then click Manage MCP Servers.",
    image: findMcpImage,
    alt: "The Roblox Studio Assistant menu with Manage MCP Servers selected",
  },
  {
    title: "Enable Studio as MCP server",
    description: "Turn on Enable Studio as MCP server.",
    image: flipSwitchImage,
    alt: "Roblox Studio Assistant Settings with Enable Studio as MCP server turned on",
  },
] as const;

const PROBLEM_COPY: Record<StudioMcpProblem, string> = {
  not_installed:
    "BloxBot can't find Roblox Studio. Install or update it, then follow the steps above.",
  unavailable:
    "Roblox Studio stopped responding. Open it so it can finish updating, or reinstall it if this keeps happening.",
};

interface StudioSetupProps {
  connected: boolean;
  checking: boolean;
  /** Set when BloxBot knows why it can't reach Studio's MCP helper. */
  problem?: StudioMcpProblem | null;
  onCheck: () => void;
  onContinue: () => void;
  /** Offered when this was opened by choice, so there's a way back without connecting. */
  onDismiss?: () => void;
  /** Offered the first time, for people who aren't here to use Studio at all. */
  onSkip?: () => void;
  /** Connected, but this chat's own place isn't open, so it needs someone to pick one. */
  needsChoice?: boolean;
}

function StudioSetup({
  connected,
  checking,
  problem,
  onCheck,
  onContinue,
  onDismiss,
  onSkip,
  needsChoice = false,
}: StudioSetupProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STUDIO_SETUP_STEPS[stepIndex];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [notFound, setNotFound] = useState(false);
  const wasChecking = useRef(false);

  // A check that finds nothing looks like nothing happened unless something says so.
  useEffect(() => {
    if (checking) setNotFound(false);
    else if (wasChecking.current && !connected) setNotFound(true);
    wasChecking.current = checking;
  }, [checking, connected]);

  const continueRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  // A whole new screen, so keyboard and screen reader users start at its top.
  useEffect(() => {
    if (connected) continueRef.current?.focus();
    else headingRef.current?.focus();
  }, [connected]);

  // Back goes away on the first step, and focus must not go with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the step changes
  useEffect(() => {
    if (document.activeElement === document.body) nextRef.current?.focus();
  }, [stepIndex]);

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
          <output className="mt-5 block">
            <h1 className="text-lg font-medium">Studio connected</h1>
          </output>
          <p className="mt-2 text-sm text-muted-foreground">
            {needsChoice
              ? "Choose which place this chat should work in."
              : "BloxBot is in the driver's seat. You're ready to build."}
          </p>
          <button
            ref={continueRef}
            type="button"
            onClick={onContinue}
            className="mt-6 inline-flex h-10 items-center rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            {needsChoice ? "Choose a place" : "Let's build"}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto px-6 py-5">
      {/* m-auto, because centering with flex would cut the top off in a short window. Width sets the
          screenshot's height, so this keeps the whole step in view without scrolling. */}
      <section
        className="animate-fade-in-up m-auto w-full"
        style={{ maxWidth: "max(24rem, min(42rem, calc((100vh - 21rem) * 16 / 9)))" }}
        aria-labelledby="studio-setup-title"
      >
        <header className="flex items-center gap-4">
          <BloxBotFace />
          <div className="flex-1">
            <p className="text-xs font-medium text-muted-foreground">One tiny setup</p>
            <h1
              ref={headingRef}
              id="studio-setup-title"
              tabIndex={-1}
              className="text-lg font-medium outline-none"
            >
              Let&apos;s connect Studio
            </h1>
          </div>
          {onDismiss ? (
            <button
              type="button"
              onClick={onDismiss}
              className="h-9 shrink-0 rounded-lg border px-4 text-xs font-medium transition-colors hover:bg-muted"
            >
              Back to chat
            </button>
          ) : onSkip ? (
            <button
              type="button"
              onClick={onSkip}
              className="h-9 shrink-0 rounded-lg border px-4 text-xs font-medium transition-colors hover:bg-muted"
            >
              Skip for now
            </button>
          ) : null}
        </header>

        <div className="mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <div>
              <output className="sr-only">
                Step {stepIndex + 1} of {STUDIO_SETUP_STEPS.length}. {step.description}
              </output>
              <p aria-hidden="true" className="text-xs font-medium text-muted-foreground">
                Step {stepIndex + 1} of {STUDIO_SETUP_STEPS.length}
              </p>
              <h2 className="mt-0.5 text-base font-medium">{step.title}</h2>
            </div>
            <div className="flex gap-1.5" aria-hidden="true">
              {STUDIO_SETUP_STEPS.map((item, index) => (
                <span
                  key={item.title}
                  className={`h-1.5 rounded-full transition-all ${
                    index === stepIndex ? "w-6 bg-foreground" : "w-1.5 bg-foreground/15"
                  }`}
                />
              ))}
            </div>
          </div>

          <StudioScreenshot step={stepIndex} image={step.image} alt={step.alt} />

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
              {stepIndex < STUDIO_SETUP_STEPS.length - 1 ? (
                <button
                  ref={nextRef}
                  type="button"
                  onClick={() => setStepIndex((current) => current + 1)}
                  className="h-9 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition-opacity hover:opacity-90"
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!checking) onCheck();
                  }}
                  aria-disabled={checking}
                  aria-busy={checking}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-xs font-medium text-background transition-opacity hover:opacity-90 aria-disabled:opacity-60"
                >
                  {checking && (
                    <svg
                      className="h-3.5 w-3.5 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="9"
                        stroke="currentColor"
                        strokeWidth="3"
                      />
                      <path
                        className="opacity-90"
                        fill="currentColor"
                        d="M21 12a9 9 0 0 0-9-9v3a6 6 0 0 1 6 6h3Z"
                      />
                    </svg>
                  )}
                  {checking ? "Checking..." : "Check now"}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-col items-center gap-1 text-center text-xs leading-relaxed text-muted-foreground">
          {problem ? (
            <output className="flex max-w-lg items-start justify-center gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-red-400" aria-hidden="true" />
              <span>
                {PROBLEM_COPY[problem]}
                {problem === "not_installed" ? (
                  <>
                    {" "}
                    <a
                      href="https://create.roblox.com/docs/studio/setup"
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-foreground"
                    >
                      Get Roblox Studio
                    </a>
                  </>
                ) : null}
              </span>
            </output>
          ) : notFound ? null : (
            <p className="flex items-center gap-2">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              Looking for Roblox Studio
            </p>
          )}
          <output>
            {notFound && !problem
              ? "Not found yet. Check these steps, then restart Studio."
              : notFound
                ? "Not found yet."
                : null}
          </output>
          {stepIndex < STUDIO_SETUP_STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => {
                if (!checking) onCheck();
              }}
              aria-busy={checking}
              className="underline underline-offset-2 hover:text-foreground aria-busy:opacity-60"
            >
              Check now
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function StudioScreenshot({ step, image, alt }: { step: number; image: string; alt: string }) {
  return (
    <div className={`studio-screenshot studio-screenshot--${step}`}>
      <div key={image} className="studio-screenshot-camera">
        <img src={image} alt={alt} />
      </div>
      <span key={`cursor-${image}`} className="studio-screenshot-cursor" aria-hidden="true">
        <i />
        <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
          <path
            d="M2.3 1.9 19.2 15c.8.6.4 1.9-.6 2l-7 .7-3.4 6.1c-.5.9-1.8.7-2-.3L.6 3.1c-.3-1.1.8-1.9 1.7-1.2Z"
            fill="white"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      </span>
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
