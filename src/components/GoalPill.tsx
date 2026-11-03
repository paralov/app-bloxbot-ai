import { CircleAlert, CircleCheck, Pause, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { MENU_TRIGGER, MenuContent } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import type { SessionGoal } from "@/lib/opencode/types";

const STATUS = {
  active: { label: "Goal", icon: Target, tone: "" },
  paused: { label: "Goal paused", icon: CircleAlert, tone: "text-amber-600 dark:text-amber-400" },
  complete: {
    label: "Goal met",
    icon: CircleCheck,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
} as const;

type GoalCommand = "pause" | "resume" | "clear";

/** The chat's /goal above the composer, as in OpenCode's desktop app: its status, and what you can do with it. */
export default function GoalPill({
  goal,
  onCommand,
}: {
  goal: SessionGoal;
  onCommand: (command: GoalCommand) => void;
}) {
  const [open, setOpen] = useState(false);
  const status = STATUS[goal.status];

  function run(command: GoalCommand) {
    setOpen(false);
    onCommand(command);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`${MENU_TRIGGER} gap-1.5 ${status.tone}`}
          title={goal.objective}
        >
          <status.icon aria-hidden="true" size={14} className="shrink-0" />
          {status.label}
        </button>
      </PopoverTrigger>
      <MenuContent side="top" align="start" className="w-72">
        <p className="px-2 pt-1.5 text-xs break-words">{goal.objective}</p>
        {goal.reason ? (
          <p className="px-2 pt-1 text-xs break-words text-muted-foreground">{goal.reason}</p>
        ) : null}
        <div className="flex justify-end gap-1 pt-1.5">
          {goal.status === "active" ? (
            <button
              type="button"
              className={`${MENU_TRIGGER} gap-1.5`}
              onClick={() => run("pause")}
            >
              <Pause aria-hidden="true" size={14} />
              Pause
            </button>
          ) : null}
          {goal.status === "paused" ? (
            <button
              type="button"
              className={`${MENU_TRIGGER} gap-1.5`}
              onClick={() => run("resume")}
            >
              <Play aria-hidden="true" size={14} />
              Resume
            </button>
          ) : null}
          <button type="button" className={`${MENU_TRIGGER} gap-1.5`} onClick={() => run("clear")}>
            <Trash2 aria-hidden="true" size={14} />
            Clear
          </button>
        </div>
      </MenuContent>
    </Popover>
  );
}
