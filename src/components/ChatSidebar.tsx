import type { Session } from "@opencode-ai/sdk/v2/client";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { type MouseEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { useArchiveSession } from "@/hooks/mutations/useArchiveSession";
import { useCreateSession } from "@/hooks/mutations/useCreateSession";
import { useDeleteSession } from "@/hooks/mutations/useDeleteSession";
import { useRenameSession } from "@/hooks/mutations/useRenameSession";
import { useUnarchiveSession } from "@/hooks/mutations/useUnarchiveSession";
import { useSessionStatuses } from "@/hooks/useSessionStatuses";
import { useSessions } from "@/hooks/useSessions";
import { analyticsProperties, countBucket } from "@/lib/analytics";
import { useActiveSession } from "@/providers/ActiveSessionProvider";

interface ChatSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onSessionSelect: () => void;
  onOpenSettings: () => void;
}

function formatTime(timestamp: number): string {
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
  if (!status) return "bg-muted-foreground/35";
  switch (status.type) {
    case "busy":
      return "bg-amber-400 animate-pulse";
    case "idle":
      return "bg-muted-foreground/35";
    default:
      return "bg-muted-foreground/35";
  }
}

const ChatSidebar = memo(function ChatSidebar({
  collapsed,
  onToggle,
  onSessionSelect,
  onOpenSettings,
}: ChatSidebarProps) {
  const { data: sessions = [] } = useSessions();
  const { activeSessionId, selectSession } = useActiveSession();
  const { data: sessionStatuses = {} } = useSessionStatuses();
  const createSession = useCreateSession();
  const archiveSession = useArchiveSession();
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  const unarchiveSession = useUnarchiveSession();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [snoozedExpanded, setSnoozedExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    session: Session;
    x: number;
    y: number;
  } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const { activeSessions, snoozedSessions } = useMemo(() => {
    const active: Session[] = [];
    const snoozed: Session[] = [];
    for (const session of sessions) {
      (session.time.archived ? snoozed : active).push(session);
    }
    return { activeSessions: active, snoozedSessions: snoozed };
  }, [sessions]);

  function handleSelect(id: string) {
    onSessionSelect();
    selectSession(id);
  }

  function handleCreate() {
    onSessionSelect();
    createSession.mutate();
  }

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  function startRename(session: { id: string; title?: string }) {
    setEditingId(session.id);
    setEditValue(session.title || "Untitled");
  }

  function commitRename() {
    if (editingId && editValue.trim()) {
      renameSession.mutate({ sessionID: editingId, title: editValue.trim() });
    }
    setEditingId(null);
  }

  function handleSnooze(sessionID: string) {
    const status = sessionStatuses[sessionID];
    if (status && status.type !== "idle") return;
    archiveSession.mutate(sessionID);
  }

  function handleSnoozedSelect(sessionID: string) {
    posthog.capture("snoozed_session_opened", analyticsProperties("sessions"));
    handleSelect(sessionID);
  }

  function handleUnsnooze(sessionID: string) {
    unarchiveSession.mutate(sessionID);
  }

  function openContextMenu(event: MouseEvent, session: Session) {
    event.preventDefault();
    setContextMenu({
      session,
      x: Math.min(event.clientX, window.innerWidth - 176),
      y: Math.min(event.clientY, window.innerHeight - 52),
    });
  }

  function handleSnoozedToggle() {
    setSnoozedExpanded((expanded) => {
      const nextExpanded = !expanded;
      posthog.capture(
        "snoozed_section_toggled",
        analyticsProperties("sessions", {
          expanded: nextExpanded,
          count_bucket: countBucket(snoozedSessions.length),
        }),
      );
      return nextExpanded;
    });
  }

  function handleDelete(session: Session) {
    posthog.capture("permanent_delete_requested", analyticsProperties("sessions"));
    const confirmed = window.confirm(
      `Permanently delete “${session.title || "Untitled"}”? This cannot be undone.`,
    );
    posthog.capture(
      confirmed ? "permanent_delete_confirmed" : "permanent_delete_cancelled",
      analyticsProperties("sessions", { confirmed }),
    );
    if (confirmed) {
      deleteSession.mutate(session.id);
    }
  }

  return (
    <div
      className={`flex shrink-0 flex-col border-r bg-card transition-[width] duration-200 ease-out ${
        collapsed ? "w-10" : "w-56"
      }`}
    >
      {collapsed ? (
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
        <>
          <div className="flex h-10 items-center justify-between border-b px-3">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions
            </span>
            <div className="flex items-center gap-0.5">
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

          <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
            {activeSessions.length === 0 && snoozedSessions.length === 0 && (
              <div className="animate-fade-in px-3 py-6 text-center text-xs text-muted-foreground">
                No sessions yet.
                <br />
                Start a new one to begin.
              </div>
            )}
            {activeSessions.map((session, index) => {
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
                    onContextMenu={(event) => openContextMenu(event, session)}
                    className={`group relative mx-1 rounded-md transition-colors duration-150 ${
                      isActive
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                  >
                    {isEditing ? (
                      <div className="flex items-start gap-2 px-2 py-1.5">
                        <div
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300 ${statusDot(status)}`}
                        />
                        <div className="min-w-0 flex-1">
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
                          />
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {formatTime(session.time.updated)}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        aria-current={isActive ? "page" : undefined}
                        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left"
                        onClick={() => handleSelect(session.id)}
                      >
                        <div
                          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-300 ${statusDot(status)}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium leading-snug break-words">
                            {session.title || "Untitled"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {formatTime(session.time.updated)}
                          </div>
                        </div>
                      </button>
                    )}

                    {!isEditing && (
                      <div
                        className={`absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-r-md pl-4 pr-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 ${
                          isActive
                            ? "bg-gradient-to-l from-accent from-60% to-transparent"
                            : "bg-gradient-to-l from-card from-60% to-transparent group-hover:from-accent/50"
                        }`}
                      >
                        <button
                          type="button"
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
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSnooze(session.id);
                          }}
                          disabled={status !== undefined && status.type !== "idle"}
                          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
                          title={
                            status && status.type !== "idle"
                              ? "Wait for session to finish"
                              : "Snooze"
                          }
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
                            <path d="M3 7h18" />
                            <path d="M5 7l1 13h12l1-13" />
                            <path d="M9 11h6" />
                            <path d="M8 4h8l1 3H7l1-3z" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {snoozedSessions.length > 0 && (
            <div className="shrink-0 border-t border-border/70">
              <button
                type="button"
                aria-expanded={snoozedExpanded}
                onClick={handleSnoozedToggle}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className={`transition-transform ${snoozedExpanded ? "rotate-90" : ""}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Snoozed
                <span className="ml-auto font-normal tabular-nums">{snoozedSessions.length}</span>
              </button>

              {snoozedExpanded && (
                <div className="max-h-40 overflow-y-auto overflow-x-hidden pb-1">
                  {snoozedSessions.map((session) => (
                    <div
                      key={session.id}
                      onContextMenu={(event) => openContextMenu(event, session)}
                      className="group relative mx-1 flex min-w-0 items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    >
                      <button
                        type="button"
                        onClick={() => handleSnoozedSelect(session.id)}
                        className="min-w-0 flex-1 px-2 py-1.5 text-left"
                        title={`Open snoozed session ${session.title || "Untitled"}`}
                      >
                        <div className="truncate text-[11px] leading-snug opacity-80">
                          {session.title || "Untitled"}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUnsnooze(session.id)}
                        className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100"
                        title="Unsnooze"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M3 7h18" />
                          <path d="M5 7l1 13h12l1-13" />
                          <path d="M9 11h6" />
                          <path d="M12 16v-5" />
                          <path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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

          {contextMenu && (
            <div
              className="fixed z-[200] w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-xl"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-accent"
                onClick={() => {
                  const session = contextMenu.session;
                  setContextMenu(null);
                  handleDelete(session);
                }}
              >
                Delete permanently…
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
});

export default ChatSidebar;
