import { attachLogger, LogLevel } from "@tauri-apps/plugin-log";
import { useCallback, useEffect, useRef, useState } from "react";

interface LogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Trace]: "TRACE",
  [LogLevel.Debug]: "DEBUG",
  [LogLevel.Info]: "INFO",
  [LogLevel.Warn]: "WARN",
  [LogLevel.Error]: "ERROR",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.Trace]: "text-muted-foreground/60",
  [LogLevel.Debug]: "text-muted-foreground",
  [LogLevel.Info]: "text-foreground",
  [LogLevel.Warn]: "text-amber-600",
  [LogLevel.Error]: "text-red-600",
};

const MAX_ENTRIES = 2000;

function levelBadgeClass(level: LogLevel): string {
  switch (level) {
    case LogLevel.Error:
      return "bg-red-100 text-red-700 border-red-200";
    case LogLevel.Warn:
      return "bg-amber-100 text-amber-700 border-amber-200";
    case LogLevel.Info:
      return "bg-sky-100 text-sky-700 border-sky-200";
    case LogLevel.Debug:
      return "bg-stone-100 text-stone-500 border-stone-200";
    case LogLevel.Trace:
      return "bg-stone-50 text-stone-400 border-stone-100";
    default:
      return "bg-stone-100 text-stone-500 border-stone-200";
  }
}

function DebugLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<LogLevel | null>(null);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  // Attach the log listener
  useEffect(() => {
    const unlisten = attachLogger(({ level, message }) => {
      const entry: LogEntry = {
        id: idRef.current++,
        timestamp: new Date().toISOString().slice(11, 23),
        level,
        message,
      };
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(isAtBottom);
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Filter and search
  const filtered = logs.filter((entry) => {
    if (filter !== null && entry.level !== filter) return false;
    if (search && !entry.message.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    return true;
  });

  // Level counts for filter badges
  const counts = logs.reduce(
    (acc, e) => {
      acc[e.level] = (acc[e.level] || 0) + 1;
      return acc;
    },
    {} as Record<number, number>,
  );

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
            count={counts[LogLevel.Error] || 0}
            active={filter === LogLevel.Error}
            onClick={() => setFilter(filter === LogLevel.Error ? null : LogLevel.Error)}
            className="bg-red-100 text-red-600 border-red-200"
          />
          <FilterPill
            label="WRN"
            count={counts[LogLevel.Warn] || 0}
            active={filter === LogLevel.Warn}
            onClick={() => setFilter(filter === LogLevel.Warn ? null : LogLevel.Warn)}
            className="bg-amber-100 text-amber-600 border-amber-200"
          />
          <FilterPill
            label="INF"
            count={counts[LogLevel.Info] || 0}
            active={filter === LogLevel.Info}
            onClick={() => setFilter(filter === LogLevel.Info ? null : LogLevel.Info)}
            className="bg-sky-100 text-sky-600 border-sky-200"
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
                      {LEVEL_LABELS[entry.level]}
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
