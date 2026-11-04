import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Bot,
  Brain,
  ChevronRight,
  CircleAlert,
  Code2,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  lazy,
  memo,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ReferenceChip } from "@/components/ReferenceChip";
import type { HighlightLanguage } from "@/components/SyntaxHighlightedOutput";
import { analyticsProperties } from "@/lib/analytics";
import type { ExplorerReferenceKind } from "@/lib/explorer";
import type {
  Part,
  PermissionRequest,
  QuestionAnswer,
  QuestionRequest,
  SessionStatus,
} from "@/lib/opencode/types";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";

/** Module-level constant to avoid creating a new array on every render. */
const REMARK_PLUGINS = [remarkGfm];
const INSTANCE_REFERENCE_PATTERN =
  /<Instance reference="([^"]+)"(?: (property|attribute|tag)="[^"]*")?>([^<]+)<\/Instance>/g;
const SyntaxHighlightedOutput = lazy(() => import("@/components/SyntaxHighlightedOutput"));
const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, HighlightLanguage> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  diff: "diff",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  lua: "lua",
  luau: "lua",
  shellsession: "shellsession",
  console: "shellsession",
  typescript: "typescript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "tsx",
};

import { useAnswerQuestion, useRejectQuestion } from "@/hooks/mutations/useAnswerQuestion";
import { useReplyPermission } from "@/hooks/mutations/useReplyPermission";
import { useMessage, useMessageIds } from "@/hooks/useMessages";
import { useActivePermission } from "@/hooks/usePermissions";
import { useActiveQuestion } from "@/hooks/useQuestions";
import { useSessionError } from "@/hooks/useSessionError";
import { useSessionStatus } from "@/hooks/useSessionStatuses";
import {
  freeLimitEndsAt,
  isFreeUsageLimit,
  type ModelError,
  presentModelError,
} from "@/lib/modelError";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import type { MessageWithParts } from "@/types";

// ── Image lightbox ───────────────────────────────────────────────────────

interface LightboxState {
  urls: string[];
  index: number;
}

/** Module-level lightbox setter  - avoids prop drilling through memoized bubbles. */
let setLightboxState: ((state: LightboxState | null) => void) | null = null;

function openLightbox(urls: string[], index: number) {
  setLightboxState?.({ urls, index });
}

const ImageLightbox = memo(function ImageLightbox() {
  const [state, setState] = useState<LightboxState | null>(null);
  const [slideDir, setSlideDir] = useState<"left" | "right" | null>(null);
  const [animKey, setAnimKey] = useState(0);
  const isOpen = state !== null;

  useEffect(() => {
    setLightboxState = setState;
    return () => {
      setLightboxState = null;
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setState(null);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setState((s) => {
          if (!s || s.urls.length <= 1) return s;
          setSlideDir("left");
          setAnimKey((k) => k + 1);
          return { ...s, index: (s.index + 1) % s.urls.length };
        });
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setState((s) => {
          if (!s || s.urls.length <= 1) return s;
          setSlideDir("right");
          setAnimKey((k) => k + 1);
          return { ...s, index: (s.index - 1 + s.urls.length) % s.urls.length };
        });
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen]);

  if (!state) return null;

  const { urls, index } = state;
  const hasMultiple = urls.length > 1;

  function goNext(e: React.MouseEvent) {
    e.stopPropagation();
    setSlideDir("left");
    setAnimKey((k) => k + 1);
    setState((s) => s && { ...s, index: (s.index + 1) % s.urls.length });
  }

  function goPrev(e: React.MouseEvent) {
    e.stopPropagation();
    setSlideDir("right");
    setAnimKey((k) => k + 1);
    setState((s) => s && { ...s, index: (s.index - 1 + s.urls.length) % s.urls.length });
  }

  const slideClass =
    slideDir === "left"
      ? "animate-lightbox-slide-left"
      : slideDir === "right"
        ? "animate-lightbox-slide-right"
        : "animate-lightbox-image";

  return (
    <div
      className="animate-lightbox-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={() => setState(null)}
    >
      <button
        onClick={() => setState(null)}
        className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
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
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      {hasMultiple && (
        <button
          onClick={goPrev}
          className="absolute left-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:scale-110 hover:bg-white/20"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      <img
        key={animKey}
        src={urls[index]}
        alt={`Attachment ${index + 1} of ${urls.length}`}
        className={`max-h-[85vh] max-w-[90vw] rounded-lg object-contain shadow-2xl ${slideClass}`}
        onClick={(e) => e.stopPropagation()}
      />

      {hasMultiple && (
        <button
          onClick={goNext}
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-all hover:scale-110 hover:bg-white/20"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      )}

      {hasMultiple && (
        <div className="animate-fade-in-up absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
          {index + 1} / {urls.length}
        </div>
      )}
    </div>
  );
});

// ── Inline BloxBot thinking indicator ────────────────────────────────────

function StudLoader() {
  return (
    <span className="stud-loader" aria-hidden="true">
      {STUDS.map((stud) => (
        <span key={stud} />
      ))}
    </span>
  );
}

const STUDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function BloxBotThinking({ label = "Thinking", detail }: { label?: string; detail?: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <output className="flex min-h-[21px] min-w-0 items-center gap-2 text-sm">
      <StudLoader />
      <span className="text-shimmer">{label}</span>
      {seconds > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground/70">{seconds}s</span>
      )}
      {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>}
    </output>
  );
}

// ── Constants ───────────────────────────────────────────────────────────

// ── Helpers ─────────────────────────────────────────────────────────────

function baseToolName(tool: string): string {
  return tool.replace(/^mcp_[^_]+_/, "");
}

function inputField(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val === "string") return val;
  if (val !== undefined && val !== null) return JSON.stringify(val);
  return "";
}

// ── Tool rows ───────────────────────────────────────────────────────────
// Every tool call is one quiet line saying what happened. Details open on click.

function ToolRow({
  icon: Icon,
  label,
  detail,
  running = false,
  failed = false,
  children,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  running?: boolean;
  failed?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tone = failed ? "text-destructive" : "text-muted-foreground";
  const summary = (
    <>
      <Icon aria-hidden="true" size={13} className="shrink-0 opacity-70" />
      <span className={`shrink-0 ${running ? "text-shimmer" : ""}`}>{label}</span>
      {detail && (
        <span className="min-w-0 truncate opacity-70" title={detail}>
          {detail}
        </span>
      )}
    </>
  );
  return (
    <div data-preserve-scroll className="min-w-0">
      {children ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`group flex max-w-full items-center gap-1.5 py-0.5 text-left text-sm transition-colors hover:text-foreground ${tone}`}
        >
          {summary}
          <ChevronRight
            aria-hidden="true"
            size={12}
            className={`shrink-0 opacity-0 transition-transform group-hover:opacity-70 group-focus-visible:opacity-70 ${open ? "rotate-90 opacity-70" : ""}`}
          />
        </button>
      ) : (
        <div className={`flex max-w-full items-center gap-1.5 py-0.5 text-sm ${tone}`}>
          {summary}
        </div>
      )}
      {open && children && (
        <div className="animate-disclosure-expand mb-1 ml-1.5 mt-1 min-w-0 border-l pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

function ToolText({ text, language }: { text: string; language?: HighlightLanguage }) {
  const body = (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
      {text}
    </pre>
  );
  return (
    <div className="app-scrollbar max-h-72 overflow-auto rounded-md bg-muted/50 px-2.5 py-2 text-xs">
      {language ? (
        <Suspense fallback={body}>
          <SyntaxHighlightedOutput code={text} language={language} />
        </Suspense>
      ) : (
        body
      )}
    </div>
  );
}

function shortPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

interface ToolViewProps {
  input: Record<string, unknown>;
  output?: string;
  status: string;
}

function BashToolView({ input, output, status }: ToolViewProps) {
  const command = inputField(input, "command");
  return (
    <ToolRow
      icon={SquareTerminal}
      label={status === "completed" ? "Ran" : "Running"}
      detail={inputField(input, "description") || command}
      running={status === "running"}
    >
      <ToolText
        text={output ? `$ ${command}\n${output.slice(0, 3000)}` : `$ ${command}`}
        language="shellsession"
      />
    </ToolRow>
  );
}

function EditToolView({ input, status }: ToolViewProps) {
  const filePath = inputField(input, "filePath");
  const oldString = inputField(input, "oldString");
  const newString = inputField(input, "newString");
  const diff = [
    ...(oldString ? oldString.split("\n").map((line) => `-${line}`) : []),
    ...(newString ? newString.split("\n").map((line) => `+${line}`) : []),
  ].join("\n");
  return (
    <ToolRow
      icon={FilePen}
      label={status === "completed" ? "Edited" : "Editing"}
      detail={shortPath(filePath)}
      running={status === "running"}
    >
      {diff ? <ToolText text={diff} language="diff" /> : undefined}
    </ToolRow>
  );
}

/** GPT models edit through a patch that can touch several files. */
function PatchToolView({ input, status }: ToolViewProps) {
  const patch = inputField(input, "patchText");
  const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) =>
    shortPath(match[1] ?? ""),
  );
  return (
    <ToolRow
      icon={FilePen}
      label={status === "completed" ? "Edited" : "Editing"}
      detail={files.join(", ")}
      running={status === "running"}
    >
      {patch ? <ToolText text={patch} language="diff" /> : undefined}
    </ToolRow>
  );
}

function ReadToolView({ input, status }: ToolViewProps) {
  return (
    <ToolRow
      icon={FileText}
      label={status === "completed" ? "Read" : "Reading"}
      detail={shortPath(inputField(input, "filePath"))}
      running={status === "running"}
    />
  );
}

function WriteToolView({ input, status }: ToolViewProps) {
  const content = inputField(input, "content");
  return (
    <ToolRow
      icon={FilePlus}
      label={status === "completed" ? "Created" : "Creating"}
      detail={shortPath(inputField(input, "filePath"))}
      running={status === "running"}
    >
      {content ? <ToolText text={content.slice(0, 3000)} /> : undefined}
    </ToolRow>
  );
}

function SearchToolView({ input, status, field }: ToolViewProps & { field: string }) {
  return (
    <ToolRow
      icon={Search}
      label={status === "completed" ? "Searched" : "Searching"}
      detail={inputField(input, field)}
      running={status === "running"}
    />
  );
}

function TaskToolView({ input, output, status }: ToolViewProps) {
  return (
    <ToolRow
      icon={Bot}
      label={status === "completed" ? "Delegated" : "Delegating"}
      detail={inputField(input, "description")}
      running={status === "running"}
    >
      {output ? <ToolText text={output.slice(0, 3000)} /> : undefined}
    </ToolRow>
  );
}

function WebFetchToolView({ input, status }: ToolViewProps) {
  return (
    <ToolRow
      icon={Globe}
      label={status === "completed" ? "Fetched" : "Fetching"}
      detail={inputField(input, "url")}
      running={status === "running"}
    />
  );
}

/** What a Code Mode script did, from the tools it calls: "Inspect instance, Search game tree". */
function toolsInCode(code: string): string {
  const names = [...code.matchAll(/\btools(?:\.[\w$]+|\[["'][^"']+["']\])\.([\w$]+)\(/g)].map(
    (match) => toolTitle(match[1] ?? ""),
  );
  return [...new Set(names)].join(", ");
}

/** OpenCode's Code Mode: the script a model ran against its tools, and what it returned. */
function ExecuteToolView({ input, output, status }: ToolViewProps) {
  const code = inputField(input, "code");
  return (
    <ToolRow
      icon={Code2}
      label={status === "completed" ? "Ran code" : "Running code"}
      detail={toolsInCode(code)}
      running={status === "running"}
    >
      <div className="space-y-1.5">
        {code && <ToolText text={code} language="javascript" />}
        {output && <ToolText text={output.slice(0, 3000)} />}
      </div>
    </ToolRow>
  );
}

/** "roblox-studio_search_game_tree" reads as "Search game tree". */
function toolTitle(tool: string): string {
  const words = tool
    .replace(/^roblox-studio_/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function DefaultToolView({ tool, input, output, status }: ToolViewProps & { tool: string }) {
  const title = "title" in input ? inputField(input, "title") : "";
  return (
    <ToolRow icon={Wrench} label={toolTitle(tool)} detail={title} running={status === "running"}>
      {output ? <ToolText text={output.slice(0, 2000)} /> : undefined}
    </ToolRow>
  );
}

// ── Part renderers ─────────────────────────────────────────────────────

const INLINE_CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground";

/** Inline code that names an object in the place opens it in the Explorer. */
function InlineCode({ children }: { children?: ReactNode }) {
  const { objectIndex, focusObject } = useExplorerReference();
  const object = typeof children === "string" ? objectIndex.get(children.trim()) : null;
  if (!object) return <code className={INLINE_CODE}>{children}</code>;
  return (
    <button
      type="button"
      title={`Show ${object.path} in the Explorer`}
      onClick={() => {
        posthog.capture("chat_object_opened", analyticsProperties("explorer"));
        focusObject(object.path);
      }}
      className="cursor-pointer"
    >
      <code
        className={`${INLINE_CODE} underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground`}
      >
        {children}
      </code>
    </button>
  );
}

const markdownComponents: Components = {
  p({ children }) {
    return <p className="mb-2 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="mb-2 mt-4 first:mt-0 text-lg font-medium">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mb-2 mt-3 first:mt-0 text-base font-medium">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mb-1.5 mt-2.5 first:mt-0 text-sm font-medium">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="mb-1 mt-2 first:mt-0 text-sm font-medium">{children}</h4>;
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
    return <strong className="font-medium">{children}</strong>;
  },
  em({ children }) {
    return <em>{children}</em>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="mb-2 border-l-2 border-border pl-3 text-muted-foreground last:mb-0">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-border" />;
  },
  code({ className, children }) {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      const lang = className?.replace("language-", "") ?? "";
      const language = HIGHLIGHT_LANGUAGE_ALIASES[lang.toLowerCase()];
      const code = String(children).replace(/\n$/, "");
      return (
        <div className="mb-2 min-w-0 overflow-hidden pl-3 last:mb-0">
          {lang && <div className="mb-1 text-xs font-medium text-muted-foreground/60">{lang}</div>}
          {language ? (
            <Suspense
              fallback={
                <pre className="app-scrollbar overflow-x-auto font-mono text-sm leading-relaxed text-muted-foreground/80">
                  {code}
                </pre>
              }
            >
              <SyntaxHighlightedOutput code={code} language={language} />
            </Suspense>
          ) : (
            <pre className="app-scrollbar overflow-x-auto font-mono text-sm leading-relaxed text-muted-foreground/80">
              {code}
            </pre>
          )}
        </div>
      );
    }
    return <InlineCode>{children}</InlineCode>;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className="mb-2 overflow-x-auto last:mb-0">
        <table className="min-w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="border-b border-border bg-muted">{children}</thead>;
  },
  th({ children }) {
    return <th className="px-2 py-1 text-left font-medium text-foreground">{children}</th>;
  },
  td({ children }) {
    return <td className="border-t border-border px-2 py-1 text-foreground">{children}</td>;
  },
};

function decodeReference(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function MessageText({ text }: { text: string }) {
  const parts: Array<{
    type: "text" | "instance";
    value: string;
    label?: string;
    fieldKind?: ExplorerReferenceKind;
  }> = [];
  let cursor = 0;
  for (const match of text.matchAll(INSTANCE_REFERENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ type: "text", value: text.slice(cursor, index) });
    parts.push({
      type: "instance",
      value: decodeReference(match[1]),
      fieldKind: match[2] as ExplorerReferenceKind | undefined,
      label: decodeReference(match[3]),
    });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });

  return parts.map((part, index) =>
    part.type === "instance" ? (
      <ReferenceChip
        key={`${part.value}:${index}`}
        label={part.label ?? ""}
        path={part.value}
        fieldKind={part.fieldKind}
      />
    ) : (
      <Markdown key={index} remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {part.value}
      </Markdown>
    ),
  );
}

const TextPartView = memo(
  function TextPartView({ part }: { part: Extract<Part, { type: "text" }> }) {
    return (
      <div className="text-sm leading-relaxed">
        <MessageText text={part.text} />
      </div>
    );
  },
  (prev, next) => prev.part.text === next.part.text,
);

const ReasoningPartView = memo(function ReasoningPartView({
  part,
}: {
  part: Extract<Part, { type: "reasoning" }>;
}) {
  if (!part.text) return null;
  const thinking = !part.time?.end;
  return (
    <ToolRow icon={Brain} label={thinking ? "Thinking" : "Thought"} running={thinking}>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
        {part.text}
      </p>
    </ToolRow>
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
  const tool = baseToolName(part.tool);

  if (errorMsg) {
    return (
      <ToolRow icon={CircleAlert} label={`${toolTitle(tool)} failed`} failed>
        <ToolText text={errorMsg} />
      </ToolRow>
    );
  }

  function renderToolContent() {
    switch (tool) {
      case "bash":
        return <BashToolView input={input} output={output} status={status} />;
      case "edit":
        return <EditToolView input={input} output={output} status={status} />;
      case "patch":
        return <PatchToolView input={input} status={status} />;
      case "read":
        return <ReadToolView input={input} status={status} />;
      case "write":
        return <WriteToolView input={input} status={status} />;
      case "glob":
        return <SearchToolView input={input} status={status} field="pattern" />;
      case "grep":
        return <SearchToolView input={input} status={status} field="pattern" />;
      case "task":
        return <TaskToolView input={input} output={output} status={status} />;
      case "webfetch":
        return <WebFetchToolView input={input} status={status} />;
      case "execute":
        return <ExecuteToolView input={input} output={output} status={status} />;
      default:
        return <DefaultToolView tool={tool} input={input} output={output} status={status} />;
    }
  }

  return <div className="min-w-0 max-w-full overflow-hidden">{renderToolContent()}</div>;
});

const CompactionPartView = memo(function CompactionPartView() {
  return (
    <div className="my-1 flex items-center gap-1.5 text-xs text-muted-foreground">
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

const OPENCODE_GO_URL = "https://opencode.ai/go";

const ModelErrorCard = memo(function ModelErrorCard({
  error,
  hitAt,
  isLatest = true,
}: {
  error: ModelError;
  /** When the error happened, for a free limit that has since lifted. */
  hitAt?: number;
  isLatest?: boolean;
}) {
  const isLimit = isFreeUsageLimit(error);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!isLimit) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [isLimit]);
  const presentation = presentModelError(error, hitAt, now);

  if (presentation.kind === "usage") {
    // Once the limit has lifted or the chat has moved on, it's just history.
    const limitOver = hitAt !== undefined && now >= freeLimitEndsAt(error, hitAt);
    if (limitOver || !isLatest) {
      return <p className="my-1 text-xs text-muted-foreground">You reached the free limit here.</p>;
    }
    return (
      <div role="alert" className="my-1 rounded-xl border bg-card px-3.5 py-3">
        <div className="text-sm font-medium">{presentation.title}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {presentation.description}
        </p>
        <a
          href={OPENCODE_GO_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex h-7 items-center rounded-md bg-foreground px-2.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          See OpenCode Go
        </a>
      </div>
    );
  }

  return (
    <div role="alert" className="my-1 text-[#cf222e]/75 dark:text-[#ff7b72]/70">
      <div className="flex min-w-0 items-start gap-2">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="mt-0.5 shrink-0"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div className="min-w-0">
          <div className="text-sm font-medium leading-relaxed">{presentation.title}</div>
          <div className="text-sm leading-relaxed opacity-80">{presentation.description}</div>
          {presentation.detail && presentation.detail !== presentation.description && (
            <details className="mt-1">
              <summary className="cursor-pointer text-sm opacity-55 transition-opacity hover:opacity-100">
                Provider details
              </summary>
              <div className="mt-1 break-words pl-3 font-mono text-sm leading-relaxed opacity-70">
                {presentation.detail.slice(0, 1000)}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
});

const PartRenderer = memo(function PartRenderer({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} />;
    case "reasoning":
      return <ReasoningPartView part={part} />;
    case "tool":
      // The plan shows in its pill above the composer, but that can't report a failed update.
      if (baseToolName(part.tool) === "todowrite" && part.state.status !== "error") return null;
      return <ToolPartView part={part} />;
    case "compaction":
      return <CompactionPartView />;
    default:
      return null;
  }
});

// ── Inline todo panel ───────────────────────────────────────────────────

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
          <div className="text-xs font-medium text-foreground">{q.header}</div>
          <div className="mt-0.5 text-xs text-foreground">{q.question}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const isSelected = selected[qIdx]?.has(opt.label);
              return (
                <button
                  key={opt.label}
                  onClick={() => toggleOption(qIdx, opt.label, q.multiple)}
                  className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${isSelected ? "border-blue-400 bg-blue-100 text-blue-800 dark:border-blue-500 dark:bg-blue-950/50 dark:text-blue-300" : "border-border bg-card text-foreground hover:border-blue-300 hover:bg-blue-50 dark:hover:border-blue-700 dark:hover:bg-blue-950/30"}`}
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
              className="mt-2 w-full rounded-md border bg-transparent px-2 py-1 text-xs placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          )}
        </div>
      ))}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          Submit
        </button>
        <button
          type="button"
          onClick={() => onReject(question.id)}
          className="rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
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
    <div className="animate-fade-in-up my-2 rounded-lg border border-amber-200 bg-amber-50/30 px-3 py-3 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="text-xs font-medium text-foreground">Permission Required</div>
      <div className="mt-1 text-xs text-foreground">
        <span className="font-mono text-amber-700 dark:text-amber-400">
          {permission.permission}
        </span>
      </div>
      {permission.patterns.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {permission.patterns.map((p, i) => (
            <div key={i} className="font-mono text-xs text-muted-foreground">
              {p}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onReply(permission.id, "once")}
          className="rounded-md bg-foreground px-3 py-1 text-xs font-medium text-background transition-opacity hover:opacity-90"
        >
          Allow Once
        </button>
        <button
          type="button"
          onClick={() => onReply(permission.id, "always")}
          className="rounded-md border px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent"
        >
          Always Allow
        </button>
        <button
          type="button"
          onClick={() => onReply(permission.id, "reject")}
          className="rounded-md px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          Deny
        </button>
      </div>
    </div>
  );
});

// ── User message parts ──────────────────────────────────────────────────

const UserPartsView = memo(
  function UserPartsView({ parts }: { parts: Part[] }) {
    const fileParts: Extract<Part, { type: "file" }>[] = [];
    const textParts: Extract<Part, { type: "text" }>[] = [];
    for (const p of parts) {
      if (p.type === "file") fileParts.push(p as Extract<Part, { type: "file" }>);
      else if (p.type === "text") textParts.push(p as Extract<Part, { type: "text" }>);
    }
    const fileUrls = fileParts.map((p) => p.url);
    return (
      <div className="text-sm leading-relaxed">
        {fileParts.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {fileParts.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => openLightbox(fileUrls, i)}
                className="block cursor-zoom-in overflow-hidden rounded-lg border border-white/20 transition-opacity hover:opacity-80"
              >
                <img
                  src={p.url}
                  alt={p.filename ?? "attachment"}
                  className="max-h-32 max-w-[200px] object-cover"
                />
              </button>
            ))}
          </div>
        )}
        {textParts.map((p) => (
          <span key={p.id} className="whitespace-pre-wrap">
            {p.text}
          </span>
        ))}
        {parts.length === 0 && <span className="italic opacity-50">...</span>}
      </div>
    );
  },
  (prev, next) => prev.parts === next.parts,
);

// ── Message bubble ─────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({
  messageId,
  isLatest,
}: {
  messageId: string;
  isLatest: boolean;
}) {
  const msg = useMessage(messageId);
  if (!msg) return null;

  const isUser = msg.info.role === "user";
  const hasText = msg.parts.some((part) => part.type === "text" && part.text);

  return (
    <div
      className={`flex ${isUser ? "justify-end pb-5" : "justify-start"} ${hasText ? "pb-5" : "pb-1"}`}
    >
      <div
        className={`max-w-[85%] ${isUser ? "rounded-2xl bg-secondary px-3.5 py-2 text-foreground" : "w-full"}`}
      >
        {isUser ? (
          <UserPartsView parts={msg.parts} />
        ) : (
          <div className="space-y-1">
            {msg.parts.length === 0 &&
              msg.info.role === "assistant" &&
              !msg.info.error &&
              !msg.info.time.completed && <BloxBotThinking />}
            {msg.parts.map((part) => (
              <PartRenderer key={part.id} part={part} />
            ))}
            {"error" in msg.info &&
              msg.info.error &&
              msg.info.error.name !== "MessageAbortedError" && (
                <ModelErrorCard
                  error={msg.info.error}
                  hitAt={msg.info.time.completed ?? msg.info.time.created}
                  isLatest={isLatest}
                />
              )}
          </div>
        )}
      </div>
    </div>
  );
});

// ── Main component ─────────────────────────────────────────────────────

const BusyThinkingIndicator = memo(function BusyThinkingIndicator({
  status,
  lastMessage,
}: {
  status: SessionStatus | undefined;
  lastMessage: MessageWithParts | undefined;
}) {
  if (status?.type === "retry") {
    return <BloxBotThinking label="Waiting to retry" detail={status.message} />;
  }
  if (status?.type !== "busy" || !lastMessage || lastMessage.info.role !== "user") return null;
  return <BloxBotThinking />;
});

function ChatMessages() {
  const messageIds = useMessageIds();
  const lastMessage = useMessage(messageIds[messageIds.length - 1] ?? "");
  const sessionError = useSessionError();
  const { activeSessionId } = useActiveSession();
  const sessionStatus = useSessionStatus(activeSessionId);
  const isBusy = sessionStatus !== undefined && sessionStatus.type !== "idle";
  const activeQuestion = useActiveQuestion();
  const activePermission = useActivePermission();
  const lastMessageHasError =
    lastMessage?.info.role === "assistant" && Boolean(lastMessage.info.error);
  const answerQuestion = useAnswerQuestion();
  const rejectQuestion = useRejectQuestion();
  const replyPermission = useReplyPermission();

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const virtualizer = useVirtualizer({
    count: messageIds.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 80;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    const anchor = bottomRef.current;
    if (!el || !anchor) return;
    let rafId = 0;
    const observer = new MutationObserver((mutations) => {
      const onlyDisclosureChanges = mutations.every((mutation) => {
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return target?.closest("[data-preserve-scroll]") !== null;
      });
      if (onlyDisclosureChanges) return;
      if (!shouldAutoScroll.current) return;
      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          anchor.scrollIntoView({ behavior: "instant" });
        });
      }
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll triggers
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [isBusy, activeQuestion, activePermission]);

  const handleAnswer = useCallback(
    (requestID: string, answers: QuestionAnswer[]) => answerQuestion.mutate({ requestID, answers }),
    [answerQuestion],
  );
  const handleReject = useCallback(
    (requestID: string) => rejectQuestion.mutate(requestID),
    [rejectQuestion],
  );
  const handleReplyPermission = useCallback(
    (requestID: string, reply: "once" | "always" | "reject") =>
      replyPermission.mutate({ requestID, reply }),
    [replyPermission],
  );

  if (messageIds.length === 0 && !isBusy && !sessionError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <ImageLightbox />
        <div className="animate-fade-in-up text-center">
          <h2 className="text-lg font-medium text-foreground">What would you like to build?</h2>
          <p className="mt-2 text-xs text-muted-foreground">
            Ask me to work on your Roblox game, build a small website, or anything else.
          </p>
        </div>
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={containerRef}
      data-chat-scroll
      onScroll={handleScroll}
      className="app-scrollbar flex-1 overflow-y-auto [overflow-anchor:none]"
    >
      <ImageLightbox />
      <div className="mx-auto max-w-2xl px-4 py-4">
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}
        >
          {virtualItems.map((virtualItem) => (
            <div
              key={messageIds[virtualItem.index]}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <div>
                <MessageBubble
                  messageId={messageIds[virtualItem.index]}
                  isLatest={virtualItem.index === messageIds.length - 1}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          {activeQuestion && (
            <QuestionPrompt
              question={activeQuestion}
              onAnswer={handleAnswer}
              onReject={handleReject}
            />
          )}
          {activePermission && (
            <PermissionPrompt permission={activePermission} onReply={handleReplyPermission} />
          )}
          <BusyThinkingIndicator status={sessionStatus} lastMessage={lastMessage} />
          {sessionError && !lastMessageHasError && <ModelErrorCard error={sessionError} />}
        </div>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default ChatMessages;
