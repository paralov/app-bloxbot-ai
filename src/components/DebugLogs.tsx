import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

export interface LogEntry {
  timestamp: number;
  source: string;
  message: string;
}

/** Emit a frontend log that the DebugLogs panel will pick up. */
export function frontendLog(source: string, message: string) {
  const entry: LogEntry = {
    timestamp: Date.now() / 1000,
    source,
    message,
  };
  window.dispatchEvent(new CustomEvent("frontend-log", { detail: entry }));
}

const SOURCE_COLORS: Record<string, string> = {
  setup: "text-blue-500",
  opencode: "text-violet-500",
  "opencode:err": "text-orange-500",
  "opencode:out": "text-stone-400",
  mcp: "text-emerald-500",
  frontend: "text-cyan-500",
};

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return (
    d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
    "." +
    String(d.getMilliseconds()).padStart(3, "0")
  );
}

function DebugLogs({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  // Fetch existing logs on mount
  useEffect(() => {
    invoke<LogEntry[]>("get_logs")
      .then((entries) => setLogs(entries))
      .catch((err) => console.error("Failed to fetch logs:", err));
  }, []);

  // Subscribe to new log events (backend + frontend)
  useEffect(() => {
    function addEntry(entry: LogEntry) {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > 5000) return next.slice(-4000);
        return next;
      });
    }

    const unlisten = listen<LogEntry>("app-log", (event) => {
      addEntry(event.payload);
    });

    function handleFrontendLog(e: Event) {
      addEntry((e as CustomEvent<LogEntry>).detail);
    }
    window.addEventListener("frontend-log", handleFrontendLog);

    return () => {
      unlisten.then((fn) => fn());
      window.removeEventListener("frontend-log", handleFrontendLog);
    };
  }, []);

  // Auto-scroll to bottom when new logs arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: logs triggers scroll
  useEffect(() => {
    if (shouldAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [logs]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    shouldAutoScroll.current = distanceFromBottom < 40;
  }, []);

  // Get unique sources for filter buttons
  const sources = [...new Set(logs.map((l) => l.source))].sort();

  // Filter logs
  const query = search.toLowerCase().trim();
  const filtered = logs.filter((l) => {
    if (filter && l.source !== filter) return false;
    if (
      query &&
      !l.message.toLowerCase().includes(query) &&
      !l.source.toLowerCase().includes(query)
    )
      return false;
    return true;
  });

  function handleCopy() {
    const text = filtered
      .map((l) => `${formatTime(l.timestamp)} [${l.source}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b bg-card px-4">
        <div className="flex items-center gap-2">
          <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-700">
            DEBUG
          </span>
          <span className="text-xs text-muted-foreground">Logs</span>
          <span className="text-[10px] text-muted-foreground/50">
            ({filtered.length}
            {filter || query ? ` of ${logs.length}` : ""})
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Copy all visible logs"
          >
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
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
          <button
            onClick={() => setLogs([])}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
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
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Close
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-card/50 px-4 py-1.5">
        {/* Search */}
        <div className="flex items-center gap-1 rounded border bg-background px-2">
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-muted-foreground/50"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter logs..."
            className="h-6 w-32 bg-transparent text-[11px] placeholder:text-muted-foreground/40 focus:outline-none"
          />
        </div>

        {/* Source filters */}
        <button
          onClick={() => setFilter(null)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            filter === null
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-accent"
          }`}
        >
          All
        </button>
        {sources.map((src) => (
          <button
            key={src}
            onClick={() => setFilter(filter === src ? null : src)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              filter === src
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            {src}
          </button>
        ))}
      </div>

      {/* Log entries */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-stone-950 font-mono text-[11px] leading-[1.6]"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-stone-500">
            {logs.length === 0 ? "No logs yet..." : "No logs match the current filter"}
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {filtered.map((entry, i) => (
                <tr key={i} className="hover:bg-stone-900/50">
                  <td className="whitespace-nowrap px-2 py-px text-stone-600 align-top select-none">
                    {formatTime(entry.timestamp)}
                  </td>
                  <td
                    className={`whitespace-nowrap px-1 py-px align-top select-none ${SOURCE_COLORS[entry.source] ?? "text-stone-500"}`}
                  >
                    [{entry.source}]
                  </td>
                  <td className="px-1 py-px text-stone-200 break-all whitespace-pre-wrap">
                    {entry.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export default DebugLogs;
