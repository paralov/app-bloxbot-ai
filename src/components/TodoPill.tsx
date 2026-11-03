import { Check, Circle, CircleDot, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { MENU_TRIGGER, MenuContent } from "@/components/ui/menu";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import type { Todo } from "@/lib/opencode/types";

function TodoGlyph({ status }: { status: Todo["status"] }) {
  if (status === "completed") {
    return <Check aria-hidden="true" size={14} className="shrink-0 text-emerald-500" />;
  }
  if (status === "cancelled") {
    return <X aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />;
  }
  if (status === "in_progress") {
    return (
      <CircleDot
        aria-hidden="true"
        size={14}
        className="shrink-0 animate-pulse text-[var(--running)]"
      />
    );
  }
  return <Circle aria-hidden="true" size={14} className="shrink-0 text-muted-foreground" />;
}

/** The one the agent is on: in progress, else the next pending, else the last finished. */
function currentTodo(todos: readonly Todo[]): Todo | undefined {
  return (
    todos.find((todo) => todo.status === "in_progress") ??
    todos.find((todo) => todo.status === "pending") ??
    [...todos].reverse().find((todo) => todo.status === "completed") ??
    todos[0]
  );
}

/** Shown while a turn runs and still has work left, so an old plan never lingers. */
export function hasOpenTodos(todos: readonly Todo[]): boolean {
  return todos.some((todo) => todo.status === "in_progress" || todo.status === "pending");
}

function TodoList({ todos }: { todos: readonly Todo[] }) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = todos.findIndex((todo) => todo.status === "in_progress");

  // Keeps the task in progress in view as the plan advances.
  useEffect(() => {
    if (activeIndex >= 0)
      listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div ref={listRef} className="app-scrollbar flex max-h-56 flex-col overflow-y-auto">
      {todos.map((todo, index) => (
        <div key={`${index}:${todo.content}`} className="flex items-start gap-2 px-2 py-1 text-sm">
          <span className="flex h-5 items-center">
            <TodoGlyph status={todo.status} />
          </span>
          <span
            className={`min-w-0 flex-1 break-words ${todo.status === "completed" || todo.status === "cancelled" ? "text-muted-foreground" : ""}`}
          >
            {todo.content}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The agent's plan beside the composer, as in OpenCode's desktop app: the task in hand, then the list. */
export default function TodoPill({ todos }: { todos: readonly Todo[] }) {
  const current = currentTodo(todos);
  if (!current) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={`${MENU_TRIGGER} gap-1.5`}>
          <TodoGlyph status={current.status} />
          <span className="max-w-64 truncate">{current.content}</span>
        </button>
      </PopoverTrigger>
      <MenuContent side="top" align="start" className="w-80">
        <TodoList todos={todos} />
      </MenuContent>
    </Popover>
  );
}
