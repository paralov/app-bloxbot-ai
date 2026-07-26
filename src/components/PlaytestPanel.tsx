import { useState } from "react";
import { toast } from "sonner";
import { useGeneratePlaytestPlan } from "@/hooks/mutations/useGeneratePlaytestPlan";
import { useSendMessage } from "@/hooks/mutations/useSendMessage";
import { formatPlaytestPrompt, type PlaytestPlan } from "@/lib/playtestPlan";

function ListEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </legend>
      <div className="space-y-2">
        {items.map((item, index) => (
          <div className="flex gap-2" key={`${label}-${index}`}>
            <span className="mt-2 text-[11px] text-muted-foreground">{index + 1}.</span>
            <textarea
              aria-label={`${label} ${index + 1}`}
              value={item}
              onChange={(event) =>
                onChange(items.map((current, i) => (i === index ? event.target.value : current)))
              }
              className="min-h-9 flex-1 resize-y rounded-md border bg-background px-2.5 py-2 text-xs outline-none focus:border-ring"
            />
            {items.length > 1 ? (
              <button
                type="button"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
                className="h-8 px-1 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${label} ${index + 1}`}
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...items, ""])}
          className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
        >
          + Add item
        </button>
      </div>
    </fieldset>
  );
}

export default function PlaytestPanel({ onClose }: { onClose: () => void }) {
  const generate = useGeneratePlaytestPlan();
  const sendMessage = useSendMessage();
  const [plan, setPlan] = useState<PlaytestPlan | null>(null);

  async function generatePlan() {
    try {
      setPlan(await generate.mutateAsync());
    } catch (error) {
      toast.error("Couldn't create a playtest plan", {
        description: error instanceof Error ? error.message : "Try again.",
      });
    }
  }

  function runPlaytest() {
    if (!plan) return;
    const complete =
      plan.goal.trim() &&
      [plan.steps, plan.watchFor, plan.successCriteria].every(
        (items) => items.length > 0 && items.every((item) => item.trim()),
      );
    if (!complete) {
      toast.error("Complete every playtest field before running it.");
      return;
    }
    sendMessage.mutate(
      { text: formatPlaytestPrompt(plan) },
      {
        onSuccess: onClose,
        onError: (error) => toast.error("Playtest not started", { description: error.message }),
      },
    );
  }

  return (
    <div
      className="absolute inset-0 z-40 flex justify-end bg-black/25 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label="Playtest planner"
    >
      <div className="flex h-full w-full max-w-md flex-col border-l bg-card shadow-2xl">
        <header className="flex items-start justify-between border-b px-5 py-4">
          <div>
            <h2 className="font-serif text-xl italic">Playtest</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Turn this chat into an editable Studio test plan.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close playtest"
          >
            ×
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5">
          {!plan ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-2xl dark:bg-amber-950/50">
                ▶
              </div>
              <h3 className="text-sm font-semibold">Plan a focused test run</h3>
              <p className="mt-2 max-w-xs text-xs leading-5 text-muted-foreground">
                The planner reads this chat, but cannot use Studio tools or change your project.
              </p>
              <button
                type="button"
                onClick={generatePlan}
                disabled={generate.isPending}
                className="mt-5 rounded-lg bg-foreground px-4 py-2 text-xs font-semibold text-background disabled:opacity-50"
              >
                {generate.isPending ? "Creating plan…" : "Generate test plan"}
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <label className="block">
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Goal
                </span>
                <textarea
                  aria-label="Goal"
                  value={plan.goal}
                  onChange={(e) => setPlan({ ...plan, goal: e.target.value })}
                  className="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 text-xs outline-none focus:border-ring"
                />
              </label>
              <ListEditor
                label="Steps"
                items={plan.steps}
                onChange={(steps) => setPlan({ ...plan, steps })}
              />
              <ListEditor
                label="Watch for"
                items={plan.watchFor}
                onChange={(watchFor) => setPlan({ ...plan, watchFor })}
              />
              <ListEditor
                label="Success criteria"
                items={plan.successCriteria}
                onChange={(successCriteria) => setPlan({ ...plan, successCriteria })}
              />
            </div>
          )}
        </div>
        {plan ? (
          <footer className="flex items-center justify-between gap-3 border-t px-5 py-4">
            <button
              type="button"
              onClick={generatePlan}
              disabled={generate.isPending || sendMessage.isPending}
              className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Regenerate
            </button>
            <button
              type="button"
              onClick={runPlaytest}
              disabled={sendMessage.isPending || generate.isPending}
              className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {sendMessage.isPending ? "Starting…" : "Run playtest"}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
