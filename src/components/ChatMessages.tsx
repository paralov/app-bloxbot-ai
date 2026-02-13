import type {
  Part,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  Todo,
} from "@opencode-ai/sdk/v2/client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Module-level constant to avoid creating a new array on every render. */
const REMARK_PLUGINS = [remarkGfm];

import { useShallow } from "zustand/react/shallow";
import { useStore } from "@/stores/opencode";

// ── Inline BloxBot thinking indicator ────────────────────────────────────

/** Tiny animated BloxBot face used as the "thinking" / "waiting" indicator. */
function BloxBotThinking({ label = "Thinking..." }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <svg
        width="20"
        height="20"
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="bloxbot-face-think shrink-0"
        aria-hidden="true"
      >
        {/* Body */}
        <rect
          x="32"
          y="32"
          width="448"
          height="448"
          rx="112"
          fill="currentColor"
          className="text-foreground"
        />
        {/* Left eye */}
        <rect
          className="bloxbot-eye"
          x="144"
          y="176"
          width="72"
          height="72"
          rx="24"
          fill="var(--background)"
        />
        {/* Right eye */}
        <rect
          className="bloxbot-eye"
          x="296"
          y="176"
          width="72"
          height="72"
          rx="24"
          fill="var(--background)"
        />
        {/* Smile */}
        <path
          d="M168 328C168 328 204.8 376 256 376C307.2 376 344 328 344 328"
          stroke="var(--background)"
          strokeWidth="32"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex gap-0.5">
        <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/20" />
        <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/20 [animation-delay:150ms]" />
        <span className="bloxbot-dot h-1 w-1 rounded-full bg-foreground/20 [animation-delay:300ms]" />
      </span>
    </div>
  );
}

// ── Constants ───────────────────────────────────────────────────────────

/** CSS classes for each tool part status. Hoisted to module scope to avoid
 *  re-creating the object on every render inside ToolPartView. */
const TOOL_STATUS_COLORS: Record<string, string> = {
  pending: "border-stone-200 bg-stone-50/50",
  running: "border-amber-200 bg-amber-50/30",
  completed: "border-stone-200 bg-white",
  error: "border-red-200 bg-red-50/30",
};

// ── Helpers ─────────────────────────────────────────────────────────────

/** Strip MCP prefix (e.g. "mcp_roblox-studio_bash" -> "bash") */
function baseToolName(tool: string): string {
  return tool.replace(/^mcp_[^_]+_/, "");
}

/** Get input field safely */
function inputField(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val === "string") return val;
  if (val !== undefined && val !== null) return JSON.stringify(val);
  return "";
}

// ── Tool-specific renderers ─────────────────────────────────────────────
// These are all wrapped in memo() because they receive primitive/stable
// props from the memoized ToolPartView parent.

const BashToolView = memo(function BashToolView({
  input,
  output,
  status,
}: {
  input: Record<string, unknown>;
  output?: string;
  status: string;
}) {
  const command = inputField(input, "command");
  const description = inputField(input, "description");
  // Track open/close locally so parent re-renders don't reset it
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const autoOpen = Boolean(output && output.length < 500);
  const isOpen = detailsOpen ?? autoOpen;

  return (
    <div>
      {description && <div className="mb-1 text-[11px] text-muted-foreground">{description}</div>}
      {command && (
        <div className="rounded bg-stone-900 px-2.5 py-1.5 font-mono text-[11px] text-stone-100">
          <span className="select-none text-stone-500">$ </span>
          {command}
        </div>
      )}
      {status === "completed" && output && (
        <details
          className="mt-1"
          open={isOpen}
          onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
            Output ({output.split("\n").length} lines)
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded bg-stone-50 p-2 font-mono text-[10px] leading-tight text-stone-700">
            {output.slice(0, 3000)}
          </pre>
        </details>
      )}
      {status === "running" && (
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-amber-600">
          <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
          Running...
        </div>
      )}
    </div>
  );
});

/** Renders a split old/new diff block, splitting each string only once. */
const DiffBlock = memo(function DiffBlock({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr ? oldStr.split("\n") : [];
  const newLines = newStr ? newStr.split("\n") : [];
  return (
    <div className="mt-1.5 overflow-hidden rounded border text-[11px]">
      {oldLines.length > 0 && (
        <div className="border-b bg-red-50 px-2.5 py-1 font-mono">
          {oldLines.slice(0, 20).map((line, i) => (
            <div key={i} className="text-red-700">
              <span className="mr-2 select-none text-red-400">-</span>
              {line}
            </div>
          ))}
          {oldLines.length > 20 && (
            <div className="text-[10px] text-red-400">...{oldLines.length - 20} more lines</div>
          )}
        </div>
      )}
      {newLines.length > 0 && (
        <div className="bg-emerald-50 px-2.5 py-1 font-mono">
          {newLines.slice(0, 20).map((line, i) => (
            <div key={i} className="text-emerald-700">
              <span className="mr-2 select-none text-emerald-400">+</span>
              {line}
            </div>
          ))}
          {newLines.length > 20 && (
            <div className="text-[10px] text-emerald-400">...{newLines.length - 20} more lines</div>
          )}
        </div>
      )}
    </div>
  );
});

const EditToolView = memo(function EditToolView({
  input,
  output,
  status,
}: {
  input: Record<string, unknown>;
  output?: string;
  status: string;
}) {
  const filePath = inputField(input, "filePath");
  const oldStr = inputField(input, "oldString");
  const newStr = inputField(input, "newString");
  const shortPath = filePath.split("/").slice(-3).join("/");

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted-foreground"
        >
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
        <span className="font-mono text-muted-foreground" title={filePath}>
          {shortPath}
        </span>
      </div>
      {(oldStr || newStr) && <DiffBlock oldStr={oldStr} newStr={newStr} />}
      {status === "completed" && output && (
        <div className="mt-1 text-[10px] text-emerald-600">{output}</div>
      )}
    </div>
  );
});

const ReadToolView = memo(function ReadToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const filePath = inputField(input, "filePath");
  const shortPath = filePath.split("/").slice(-3).join("/");

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="font-mono text-muted-foreground" title={filePath}>
        {shortPath}
      </span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
      )}
    </div>
  );
});

const WriteToolView = memo(function WriteToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const filePath = inputField(input, "filePath");
  const shortPath = filePath.split("/").slice(-3).join("/");

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-emerald-600"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
      <span className="font-mono text-muted-foreground" title={filePath}>
        {shortPath}
      </span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
      )}
    </div>
  );
});

const GlobToolView = memo(function GlobToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const pattern = inputField(input, "pattern");

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span className="font-mono text-muted-foreground">{pattern}</span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
      )}
    </div>
  );
});

const GrepToolView = memo(function GrepToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const pattern = inputField(input, "pattern");
  const include = inputField(input, "include");

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span className="font-mono text-muted-foreground">
        /{pattern}/{include ? ` in ${include}` : ""}
      </span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
      )}
    </div>
  );
});

const TaskToolView = memo(function TaskToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const description = inputField(input, "description");
  const agentType = inputField(input, "subagent_type");

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-violet-500"
      >
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
      <span className="text-muted-foreground">
        {description || "Subtask"}
        {agentType && <span className="ml-1 text-[10px] text-violet-500">({agentType})</span>}
      </span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-violet-400" />
      )}
    </div>
  );
});

const WebFetchToolView = memo(function WebFetchToolView({
  input,
  status,
}: {
  input: Record<string, unknown>;
  status: string;
}) {
  const url = inputField(input, "url");
  let displayUrl = url;
  try {
    const parsed = new URL(url);
    displayUrl = parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "");
  } catch {
    /* use raw */
  }

  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
      <span className="font-mono text-muted-foreground" title={url}>
        {displayUrl}
      </span>
      {status === "running" && (
        <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
      )}
    </div>
  );
});

const TodoWriteToolView = memo(function TodoWriteToolView({
  input,
}: {
  input: Record<string, unknown>;
}) {
  const rawTodos = input.todos;
  if (!Array.isArray(rawTodos)) return null;
  const items = rawTodos as Todo[];

  return (
    <div className="space-y-0.5">
      {items.map((todo) => (
        <div key={todo.id} className="flex items-start gap-1.5 text-[11px]">
          <span className="mt-px shrink-0">
            {todo.status === "completed" ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-emerald-500"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : todo.status === "in_progress" ? (
              <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full border-2 border-amber-400" />
            ) : todo.status === "cancelled" ? (
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-stone-400"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-stone-300" />
            )}
          </span>
          <span
            className={
              todo.status === "completed"
                ? "text-muted-foreground line-through"
                : todo.status === "cancelled"
                  ? "text-muted-foreground/50 line-through"
                  : "text-foreground"
            }
          >
            {todo.content}
          </span>
        </div>
      ))}
    </div>
  );
});

const DefaultToolView = memo(function DefaultToolView({
  tool,
  input,
  output,
  status,
}: {
  tool: string;
  input: Record<string, unknown>;
  output?: string;
  status: string;
}) {
  const title = "title" in input ? inputField(input, "title") : "";
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="font-semibold text-muted-foreground">{tool}</span>
        {title && <span className="text-muted-foreground">- {title}</span>}
        {status === "running" && (
          <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-amber-400" />
        )}
      </div>
      {status === "completed" && output && (
        <details
          className="mt-1"
          open={detailsOpen}
          onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
            Output
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-stone-50 p-2 font-mono text-[10px] leading-tight text-stone-600">
            {typeof output === "string"
              ? output.slice(0, 2000)
              : JSON.stringify(output, null, 2).slice(0, 2000)}
          </pre>
        </details>
      )}
    </div>
  );
});

// ── Part renderers ─────────────────────────────────────────────────────

const markdownComponents: Components = {
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-4 first:mt-0 text-lg font-semibold">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 mt-3 first:mt-0 text-base font-semibold">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1.5 mt-2.5 first:mt-0 text-sm font-semibold">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="mb-1 mt-2 first:mt-0 text-[13px] font-semibold">{children}</h4>;
  },
  ul({ children }) {
    return <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>;
  },
  li({ children }) {
    return <li className="pl-0.5">{children}</li>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-800 hover:decoration-blue-500"
      >
        {children}
      </a>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  em({ children }) {
    return <em>{children}</em>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="mb-2 border-l-2 border-stone-300 pl-3 text-muted-foreground last:mb-0">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-stone-200" />;
  },
  code({ className, children }) {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      const lang = className?.replace("language-", "") ?? "";
      return (
        <div className="mb-2 overflow-hidden rounded-md border border-stone-200 last:mb-0">
          {lang && (
            <div className="border-b border-stone-200 bg-stone-100 px-2.5 py-1 text-[10px] font-medium text-muted-foreground">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto bg-stone-900 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-stone-100">
            <code>{children}</code>
          </pre>
        </div>
      );
    }
    return (
      <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[11.5px] text-stone-800">
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="min-w-full border-collapse text-[12px]">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="border-b border-stone-200 bg-stone-50">{children}</thead>;
  },
  th({ children }) {
    return <th className="px-2 py-1 text-left font-semibold text-foreground">{children}</th>;
  },
  td({ children }) {
    return <td className="border-t border-stone-100 px-2 py-1 text-foreground">{children}</td>;
  },
};

/** Memoized text part — only re-parses Markdown when `part.text` actually changes. */
const TextPartView = memo(
  function TextPartView({ part }: { part: Extract<Part, { type: "text" }> }) {
    return (
      <div className="text-[13px] leading-relaxed">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {part.text}
        </Markdown>
      </div>
    );
  },
  (prev, next) => prev.part.text === next.part.text,
);

/** Memoized reasoning part with controlled open state to survive re-renders. */
const ReasoningPartView = memo(function ReasoningPartView({
  part,
}: {
  part: Extract<Part, { type: "reasoning" }>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  if (!part.text) return null;
  return (
    <details
      className="group mt-1"
      open={isOpen}
      onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
        Reasoning
      </summary>
      <div className="mt-1 border-l-2 border-stone-200 pl-3 text-[12px] leading-relaxed text-muted-foreground">
        {part.text}
      </div>
    </details>
  );
});

const ToolPartView = memo(function ToolPartView({
  part,
}: {
  part: Extract<Part, { type: "tool" }>;
}) {
  const status = part.state.status;
  const input = part.state.input ?? {};
  const output = status === "completed" && "output" in part.state ? part.state.output : undefined;
  const errorMsg =
    status === "error" && "error" in part.state ? String(part.state.error) : undefined;
  const title =
    (status === "running" || status === "completed") && "title" in part.state
      ? part.state.title
      : undefined;

  const tool = baseToolName(part.tool);

  function renderToolContent() {
    switch (tool) {
      case "bash":
        return <BashToolView input={input} output={output} status={status} />;
      case "edit":
        return <EditToolView input={input} output={output} status={status} />;
      case "read":
        return <ReadToolView input={input} status={status} />;
      case "write":
        return <WriteToolView input={input} status={status} />;
      case "glob":
        return <GlobToolView input={input} status={status} />;
      case "grep":
        return <GrepToolView input={input} status={status} />;
      case "task":
        return <TaskToolView input={input} status={status} />;
      case "webfetch":
        return <WebFetchToolView input={input} status={status} />;
      case "todowrite":
        return <TodoWriteToolView input={input} />;
      default:
        return <DefaultToolView tool={tool} input={input} output={output} status={status} />;
    }
  }

  return (
    <div
      className={`my-1 rounded-md border px-2.5 py-2 ${TOOL_STATUS_COLORS[status] ?? TOOL_STATUS_COLORS.pending}`}
    >
      {title &&
        ![
          "bash",
          "edit",
          "read",
          "write",
          "glob",
          "grep",
          "task",
          "webfetch",
          "todowrite",
        ].includes(tool) && (
          <div className="mb-1 text-[11px] font-medium text-foreground">{title}</div>
        )}
      {renderToolContent()}
      {errorMsg && (
        <div className="mt-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-600">
          {errorMsg}
        </div>
      )}
    </div>
  );
});

const StepPartView = memo(function StepPartView() {
  return <div className="my-2 border-t border-stone-200" />;
});

const StepFinishPartView = memo(function StepFinishPartView({
  part,
}: {
  part: Extract<Part, { type: "step-finish" }>;
}) {
  const { tokens, cost } = part;
  return (
    <div className="my-1 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
      {cost > 0 && <span>${cost.toFixed(4)}</span>}
      <span>
        {tokens.input.toLocaleString()} in / {tokens.output.toLocaleString()} out
      </span>
      {tokens.cache.read > 0 && <span>{tokens.cache.read.toLocaleString()} cached</span>}
    </div>
  );
});

const RetryPartView = memo(function RetryPartView({
  part,
}: {
  part: Extract<Part, { type: "retry" }>;
}) {
  return (
    <div className="my-1 flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50/30 px-2.5 py-1.5 text-[11px] text-amber-700">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </svg>
      Retrying (attempt {part.attempt})
      {"error" in part && part.error?.data && "message" in part.error.data && (
        <span className="text-[10px] text-amber-600"> - {String(part.error.data.message)}</span>
      )}
    </div>
  );
});

const CompactionPartView = memo(function CompactionPartView() {
  return (
    <div className="my-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="4 14 10 14 10 20" />
        <polyline points="20 10 14 10 14 4" />
        <line x1="14" y1="10" x2="21" y2="3" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
      Context compacted
    </div>
  );
});

/**
 * Memoized part dispatcher. Each branch is itself memoized, so even when
 * this component re-renders (because a sibling part changed), the actual
 * DOM work is skipped if the part object is referentially equal.
 */
const PartRenderer = memo(function PartRenderer({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} />;
    case "reasoning":
      return <ReasoningPartView part={part} />;
    case "tool":
      return <ToolPartView part={part} />;
    case "step-start":
      return <StepPartView />;
    case "step-finish":
      return <StepFinishPartView part={part} />;
    case "retry":
      return <RetryPartView part={part} />;
    case "compaction":
      return <CompactionPartView />;
    case "snapshot":
    case "patch":
      return null;
    default:
      return null;
  }
});

// ── Inline todo panel ───────────────────────────────────────────────────

const TodoPanel = memo(function TodoPanel({ todos }: { todos: Todo[] }) {
  if (todos.length === 0) return null;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;

  return (
    <div className="animate-fade-in my-2 rounded-lg border bg-card px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-foreground">Tasks</span>
        <span className="text-[10px] text-muted-foreground">
          {completed}/{total}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-stone-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
        />
      </div>
      <div className="mt-2 space-y-1">
        {todos.map((todo) => (
          <div key={todo.id} className="flex items-start gap-1.5 text-[11px]">
            <span className="mt-0.5 shrink-0">
              {todo.status === "completed" ? (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-emerald-500"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : todo.status === "in_progress" ? (
                <span className="inline-block h-2.5 w-2.5 animate-pulse rounded-full border-2 border-amber-400" />
              ) : todo.status === "cancelled" ? (
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-stone-400"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-stone-300" />
              )}
            </span>
            <span
              className={
                todo.status === "completed"
                  ? "text-muted-foreground line-through"
                  : todo.status === "cancelled"
                    ? "text-muted-foreground/50 line-through"
                    : "text-foreground"
              }
            >
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

// ── Question prompt ─────────────────────────────────────────────────────

const QuestionPrompt = memo(function QuestionPrompt({
  question,
  onAnswer,
  onReject,
}: {
  question: QuestionRequest;
  onAnswer: (requestID: string, answers: QuestionAnswer[]) => void;
  onReject: (requestID: string) => void;
}) {
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});

  function toggleOption(qIdx: number, label: string, multiple?: boolean) {
    setSelected((prev) => {
      const current = prev[qIdx] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(label)) {
        next.delete(label);
      } else {
        if (!multiple) next.clear();
        next.add(label);
      }
      return { ...prev, [qIdx]: next };
    });
  }

  function submit() {
    const answers: QuestionAnswer[] = question.questions.map((_q, idx) => {
      const sel = selected[idx] ?? new Set<string>();
      const arr = [...sel];
      const custom = customInputs[idx]?.trim();
      if (custom) arr.push(custom);
      return arr;
    });
    onAnswer(question.id, answers);
  }

  return (
    <div className="animate-fade-in-up my-2 rounded-lg border border-blue-200 bg-blue-50/30 px-3 py-3">
      {question.questions.map((q, qIdx) => (
        <div key={qIdx} className={qIdx > 0 ? "mt-3 border-t border-blue-100 pt-3" : ""}>
          <div className="text-[11px] font-semibold text-foreground">{q.header}</div>
          <div className="mt-0.5 text-[12px] text-foreground">{q.question}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const isSelected = selected[qIdx]?.has(opt.label);
              return (
                <button
                  key={opt.label}
                  onClick={() => toggleOption(qIdx, opt.label, q.multiple)}
                  className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                    isSelected
                      ? "border-blue-400 bg-blue-100 text-blue-800"
                      : "border-stone-200 bg-white text-foreground hover:border-blue-300 hover:bg-blue-50"
                  }`}
                  title={opt.description}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {q.custom !== false && (
            <input
              type="text"
              placeholder="Type your own answer..."
              value={customInputs[qIdx] ?? ""}
              onChange={(e) => setCustomInputs((prev) => ({ ...prev, [qIdx]: e.target.value }))}
              className="mt-2 w-full rounded border bg-white px-2 py-1 text-[11px] placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          )}
        </div>
      ))}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={submit}
          className="rounded-md bg-foreground px-3 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Submit
        </button>
        <button
          onClick={() => onReject(question.id)}
          className="rounded-md px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
});

// ── Permission prompt ───────────────────────────────────────────────────

const PermissionPrompt = memo(function PermissionPrompt({
  permission,
  onReply,
}: {
  permission: PermissionRequest;
  onReply: (requestID: string, reply: "once" | "always" | "reject") => void;
}) {
  return (
    <div className="animate-fade-in-up my-2 rounded-lg border border-amber-200 bg-amber-50/30 px-3 py-3">
      <div className="text-[11px] font-semibold text-foreground">Permission Required</div>
      <div className="mt-1 text-[12px] text-foreground">
        <span className="font-mono text-amber-700">{permission.permission}</span>
      </div>
      {permission.patterns.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {permission.patterns.map((p, i) => (
            <div key={i} className="font-mono text-[10px] text-muted-foreground">
              {p}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onReply(permission.id, "once")}
          className="rounded-md bg-foreground px-3 py-1 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Allow Once
        </button>
        <button
          onClick={() => onReply(permission.id, "always")}
          className="rounded-md border px-3 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
        >
          Always Allow
        </button>
        <button
          onClick={() => onReply(permission.id, "reject")}
          className="rounded-md px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:text-destructive"
        >
          Deny
        </button>
      </div>
    </div>
  );
});

// ── Message bubble ─────────────────────────────────────────────────────

/**
 * Each MessageBubble subscribes to its own message by ID via the normalized
 * store. When a streaming update arrives, only the message that actually
 * changed gets a new object reference — so only that bubble re-renders.
 * All other bubbles are completely untouched.
 */
const MessageBubble = memo(function MessageBubble({ messageId }: { messageId: string }) {
  const msg = useStore(useCallback((s) => s.messagesById[messageId], [messageId]));
  if (!msg) return null;

  const isUser = msg.info.role === "user";

  return (
    <div className={`animate-fade-in-up flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] ${
          isUser ? "rounded-2xl rounded-br-md bg-foreground px-3.5 py-2 text-background" : "w-full"
        }`}
      >
        {isUser ? (
          <div className="text-[13px] leading-relaxed">
            {msg.parts
              .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
              .map((p) => (
                <span key={p.id}>{p.text}</span>
              ))}
            {msg.parts.length === 0 && <span className="italic opacity-50">...</span>}
          </div>
        ) : (
          <div className="space-y-1">
            {msg.parts.length === 0 && <BloxBotThinking />}
            {msg.parts.map((part) => (
              <PartRenderer key={part.id} part={part} />
            ))}
            {"error" in msg.info && msg.info.error && (
              <div className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-600">
                {msg.info.error.data && "message" in msg.info.error.data
                  ? String(msg.info.error.data.message)
                  : msg.info.error.name}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Main component ─────────────────────────────────────────────────────

/** Subscribes to the last message to show the busy thinking indicator. */
const BusyThinkingIndicator = memo(function BusyThinkingIndicator() {
  const messageIds = useStore(useShallow((s) => s.messageIds));
  const isBusy = useStore((s) => s.isBusy);
  const lastId = messageIds.length > 0 ? messageIds[messageIds.length - 1] : null;
  const lastMsg = useStore((s) => (lastId ? s.messagesById[lastId] : undefined));
  if (!isBusy || !lastMsg || lastMsg.info.role !== "user") return null;
  return <BloxBotThinking />;
});

function ChatMessages() {
  // messageIds is a lightweight string[] — only changes when messages are added/removed,
  // NOT when a message's content (parts) is updated during streaming.
  const messageIds = useStore(useShallow((s) => s.messageIds));
  const isBusy = useStore((s) => s.isBusy);
  const todos = useStore((s) => s.todos);
  const activeQuestion = useStore((s) => s.activeQuestion);
  const activePermission = useStore((s) => s.activePermission);

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 80;
  }, []);

  // Auto-scroll: use a MutationObserver on the scroll container to detect
  // DOM changes (new parts, updated text) without subscribing to message content.
  useEffect(() => {
    const el = containerRef.current;
    const anchor = bottomRef.current;
    if (!el || !anchor) return;
    const observer = new MutationObserver(() => {
      if (shouldAutoScroll.current) {
        anchor.scrollIntoView({ behavior: "smooth" });
      }
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  // Also scroll when these reactive values change (new todos, questions, etc.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll triggers
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isBusy, todos, activeQuestion, activePermission]);

  if (messageIds.length === 0 && !isBusy) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <div className="animate-fade-in-up text-center">
          <h2 className="font-serif text-2xl italic text-foreground">
            What would you like to build?
          </h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Ask me to create scripts, design game mechanics, or modify your Roblox Studio project.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4">
        {messageIds.map((id) => (
          <MessageBubble key={id} messageId={id} />
        ))}

        {/* Inline todo panel */}
        {todos.length > 0 && <TodoPanel todos={todos} />}

        {/* Question prompt */}
        {activeQuestion && (
          <QuestionPrompt
            question={activeQuestion}
            onAnswer={useStore.getState().answerQuestion}
            onReject={useStore.getState().rejectQuestion}
          />
        )}

        {/* Permission prompt */}
        {activePermission && (
          <PermissionPrompt
            permission={activePermission}
            onReply={useStore.getState().replyPermission}
          />
        )}

        {/* Busy indicator when last message is from user */}
        <BusyThinkingIndicator />

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default ChatMessages;
