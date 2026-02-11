import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Types ───────────────────────────────────────────────────────────────

/** Matches the `LogEntry` struct serialised from Rust. */
interface RawLogEntry {
  timestamp: number;
  level: "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";
  message: string;
}

type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<LogLevel, string> = {
  TRACE: "text-muted-foreground/60",
  DEBUG: "text-muted-foreground",
  INFO: "text-foreground",
  WARN: "text-amber-600",
  ERROR: "text-red-600",
};

function levelBadgeClass(level: LogLevel): string {
  switch (level) {
    case "ERROR":
      return "bg-red-100 text-red-700 border-red-200";
    case "WARN":
      return "bg-amber-100 text-amber-700 border-amber-200";
    case "INFO":
      return "bg-sky-100 text-sky-700 border-sky-200";
    case "DEBUG":
      return "bg-stone-100 text-stone-500 border-stone-200";
    case "TRACE":
      return "bg-stone-50 text-stone-400 border-stone-100";
    default:
      return "bg-stone-100 text-stone-500 border-stone-200";
  }
}

function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(11, 23);
}

const MAX_ENTRIES = 5000;

// ── Component ───────────────────────────────────────────────────────────

function DebugLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel | null>(null);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  // Convert a raw entry from Rust into our display format.
  const toLogEntry = useCallback((raw: RawLogEntry): LogEntry => {
    return {
      id: idRef.current++,
      timestamp: formatTimestamp(raw.timestamp),
      level: raw.level,
      message: raw.message,
    };
  }, []);

  // On mount: fetch the full buffer, then subscribe to new events.
  useEffect(() => {
    let cancelled = false;

    // 1. Start real-time listener immediately so nothing is missed.
    const unlistenPromise = listen<RawLogEntry>("log-entry", (event) => {
      if (cancelled) return;
      const entry = toLogEntry(event.payload);
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });

    // 2. Fetch history from the ring buffer and prepend.
    invoke<RawLogEntry[]>("get_logs")
      .then((history) => {
        if (cancelled) return;
        const entries = history.map((r) => toLogEntry(r));
        setLogs((prev) => {
          // Merge: history first, then any real-time entries that arrived
          // while invoke was in flight.
          const merged = [...entries, ...prev];
          return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
        });
      })
      .catch((err) => console.error("Failed to load log history:", err));

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn());
    };
  }, [toLogEntry]);

  // Auto-scroll to bottom when new logs arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: logs used as trigger
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Detect manual scroll to disable auto-scroll.
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  // Filtered view + counts (memoized).
  const filtered = useMemo(
    () =>
      logs.filter((entry) => {
        if (filter !== null && entry.level !== filter) return false;
        if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) {
          return false;
        }
        return true;
      }),
    [logs, filter, search],
  );

  const counts = useMemo(
    () =>
      logs.reduce(
        (acc, e) => {
          acc[e.level] = (acc[e.level] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    [logs],
  );

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col bg-background font-mono text-xs">
      {/* Toolbar */}
      <div
        className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2"
        data-tauri-drag-region
      >
        <span className="mr-1 font-sans text-sm font-medium text-foreground">Logs</span>

        {/* Level filter pills */}
        <div className="flex items-center gap-1">
          <FilterPill
            label="All"
            count={logs.length}
            active={filter === null}
            onClick={() => setFilter(null)}
            className="bg-stone-100 text-stone-600 border-stone-200"
          />
          <FilterPill
            label="ERR"
            count={counts.ERROR || 0}
            active={filter === "ERROR"}
            onClick={() => setFilter(filter === "ERROR" ? null : "ERROR")}
            className="bg-red-100 text-red-600 border-red-200"
          />
          <FilterPill
            label="WRN"
            count={counts.WARN || 0}
            active={filter === "WARN"}
            onClick={() => setFilter(filter === "WARN" ? null : "WARN")}
            className="bg-amber-100 text-amber-600 border-amber-200"
          />
          <FilterPill
            label="INF"
            count={counts.INFO || 0}
            active={filter === "INFO"}
            onClick={() => setFilter(filter === "INFO" ? null : "INFO")}
            className="bg-sky-100 text-sky-600 border-sky-200"
          />
          <FilterPill
            label="DBG"
            count={counts.DEBUG || 0}
            active={filter === "DEBUG"}
            onClick={() => setFilter(filter === "DEBUG" ? null : "DEBUG")}
            className="bg-stone-100 text-stone-500 border-stone-200"
          />
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Filter..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto h-6 w-40 rounded border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {/* Clear */}
        <button
          type="button"
          onClick={clearLogs}
          className="h-6 rounded border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-muted-foreground/60">
            {logs.length === 0 ? "Waiting for log events..." : "No logs match the current filter"}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id} className="border-b border-border/40 hover:bg-muted/40">
                  <td className="whitespace-nowrap px-2 py-0.5 text-muted-foreground/60">
                    {entry.timestamp}
                  </td>
                  <td className="px-1 py-0.5">
                    <span
                      className={`inline-block w-[3.5rem] rounded border px-1 text-center text-[10px] leading-4 ${levelBadgeClass(entry.level)}`}
                    >
                      {entry.level}
                    </span>
                  </td>
                  <td className={`break-all px-2 py-0.5 ${LEVEL_COLORS[entry.level]}`}>
                    {entry.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="flex shrink-0 items-center justify-between border-t bg-card px-3 py-1 text-[10px] text-muted-foreground">
        <span>
          {filtered.length === logs.length
            ? `${logs.length} entries`
            : `${filtered.length} / ${logs.length} entries`}
        </span>
        {!autoScroll && (
          <button
            type="button"
            onClick={() => {
              setAutoScroll(true);
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            className="rounded border bg-background px-1.5 py-0.5 hover:text-foreground"
          >
            Scroll to bottom
          </button>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onClick,
  className,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-1.5 py-0 text-[10px] leading-4 transition-opacity ${className} ${active ? "opacity-100 ring-1 ring-ring" : "opacity-50 hover:opacity-75"}`}
    >
      {label}
      {count > 0 && <span className="ml-0.5 opacity-70">{count}</span>}
    </button>
  );
}

export default DebugLogs;
