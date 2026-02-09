import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectSessions, useStore } from "@/stores/opencode";

interface ChatSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onSessionSelect: () => void;
  onOpenSettings: () => void;
}

function formatTime(timestamp: number): string {
  // OpenCode timestamps may be seconds or milliseconds; detect by magnitude
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const date = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusDot(status?: { type: string }): string {
  if (!status) return "bg-stone-300";
  switch (status.type) {
    case "busy":
      return "bg-amber-400 animate-pulse";
    case "idle":
      return "bg-stone-300";
    default:
      return "bg-stone-300";
  }
}

function ChatSidebar({ collapsed, onToggle, onSessionSelect, onOpenSettings }: ChatSidebarProps) {
  const sessions = useStore(useShallow(selectSessions));
  const activeSessionId = useStore((s) => s.activeSession?.id ?? null);
  const sessionStatuses = useStore((s) => s.sessionStatuses);
  const showAllSessions = useStore((s) => s.showAllSessions);
  const setShowAllSessions = useStore((s) => s.setShowAllSessions);
  const storeSelectSession = useStore((s) => s.selectSession);
  const storeCreateSession = useStore((s) => s.createSession);
  const storeDeleteSession = useStore((s) => s.deleteSession);
  const storeRenameSession = useStore((s) => s.renameSession);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  function handleSelect(id: string) {
    onSessionSelect();
    storeSelectSession(id);
  }

  function handleCreate() {
    onSessionSelect();
    storeCreateSession();
  }

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // Close filter dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setShowFilter(false);
      }
    }
    if (showFilter) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [showFilter]);

  function startRename(session: { id: string; title?: string }) {
    setEditingId(session.id);
    setEditValue(session.title || "Untitled");
  }

  function commitRename() {
    if (editingId && editValue.trim()) {
      storeRenameSession(editingId, editValue.trim());
    }
    setEditingId(null);
  }

  return (
    <div
      className={`flex shrink-0 flex-col border-r bg-card transition-[width] duration-200 ease-out ${
        collapsed ? "w-10" : "w-56"
      }`}
    >
      {collapsed ? (
        /* ── Collapsed state ──────────────────────────────────────── */
        <div className="flex flex-1 flex-col items-center justify-between py-2">
          <div className="flex flex-col items-center">
            <button
              onClick={onToggle}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Expand sidebar"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <button
              onClick={handleCreate}
              className="mt-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="New session"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <button
            onClick={onOpenSettings}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Settings"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      ) : (
        /* ── Expanded state ───────────────────────────────────────── */
        <>
          {/* Header */}
          <div className="flex h-10 items-center justify-between border-b px-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions
            </span>
            <div className="flex items-center gap-0.5">
              {/* Filter button */}
              <div className="relative" ref={filterRef}>
                <button
                  onClick={() => setShowFilter(!showFilter)}
                  className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
                    showAllSessions
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                  title="Filter sessions"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                  </svg>
                </button>
                {showFilter && (
                  <div className="animate-scale-in absolute left-0 top-full z-50 mt-1 w-44 rounded-lg border bg-popover p-1 shadow-lg">
                    <button
                      onClick={() => {
                        if (showAllSessions) setShowAllSessions(false);
                        setShowFilter(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        !showAllSessions
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <span className="flex h-3.5 w-3.5 items-center justify-center">
                        {!showAllSessions && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      BloxBot sessions
                    </button>
                    <button
                      onClick={() => {
                        if (!showAllSessions) setShowAllSessions(true);
                        setShowFilter(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
                        showAllSessions
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <span className="flex h-3.5 w-3.5 items-center justify-center">
                        {showAllSessions && (
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="3"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      All sessions
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={handleCreate}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="New session"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                onClick={onToggle}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="Collapse sidebar"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Session list */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
            {sessions.length === 0 && (
              <div className="animate-fade-in px-3 py-6 text-center text-xs text-muted-foreground">
                No sessions yet.
                <br />
                Start a new one to begin.
              </div>
            )}
            {sessions.map((session, index) => {
              const isActive = session.id === activeSessionId;
              const isEditing = session.id === editingId;
              const status = sessionStatuses[session.id];

              return (
                <div
                  key={session.id}
                  className="animate-slide-in-left"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <div
                    className={`group relative mx-1 flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 ${
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                    onClick={() => !isEditing && handleSelect(session.id)}
                  >
                    <div
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300 ${statusDot(status)}`}
                    />
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <input
                          ref={editRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          className="w-full rounded bg-background px-1 text-xs outline-none ring-1 ring-ring"
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div className="truncate text-xs font-medium leading-snug">
                          {session.title || "Untitled"}
                        </div>
                      )}
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {formatTime(session.time.updated)}
                      </div>
                    </div>

                    {/* Actions (visible on hover) */}
                    {!isEditing && (
                      <div
                        className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pl-4 pr-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
                          isActive
                            ? "bg-gradient-to-l from-accent from-60% to-transparent"
                            : "bg-gradient-to-l from-card from-60% to-transparent group-hover:from-accent/50"
                        }`}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(session);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                          title="Rename"
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
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                          </svg>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            storeDeleteSession(session.id);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-destructive"
                          title="Delete"
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
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer: Settings */}
          <div className="shrink-0 border-t px-3 py-2 space-y-1">
            <button
              onClick={onOpenSettings}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default ChatSidebar;
