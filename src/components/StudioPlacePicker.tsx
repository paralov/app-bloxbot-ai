import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useStudioAssignments } from "@/hooks/useStudioAssignments";
import { useStudioPlaces } from "@/hooks/useStudioPlaces";

export default function StudioPlacePicker({ sessionID }: { sessionID: string }) {
  const { assignments, setAssignment } = useStudioAssignments();
  const { data: places, error, isError, isFetching, refetch } = useStudioPlaces();
  const assignment = assignments[sessionID];
  const assignedIsConnected = places?.some((place) => place.id === assignment?.id) ?? false;
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void refetch();
    const handleOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open, refetch]);

  const choose = async (place: { id: string; name: string } | null) => {
    try {
      await setAssignment(sessionID, place);
      setOpen(false);
    } catch (error) {
      toast.error("Place assignment not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="relative min-w-0" ref={pickerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`flex max-w-56 items-center gap-1.5 rounded-md px-2 py-1 text-[10px] transition-colors hover:bg-accent ${
          assignment && !assignedIsConnected
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground hover:text-foreground"
        }`}
        title="Assign this session to a Roblox Studio place"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            assignment && assignedIsConnected ? "bg-emerald-500" : "bg-muted-foreground/40"
          }`}
        />
        <span className="truncate">{assignment ? assignment.name : "Choose Studio place"}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border bg-popover p-1 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Roblox Studio places
            </span>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {isFetching ? "Checking…" : "Refresh"}
            </button>
          </div>

          {assignment ? (
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Use automatic Studio selection
            </button>
          ) : null}

          {places?.map((place) => (
            <button
              type="button"
              key={place.id}
              onClick={() => choose({ id: place.id, name: place.name })}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent ${
                assignment?.id === place.id ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              <span className="min-w-0 flex-1 truncate text-xs">{place.name}</span>
              <span className="shrink-0 font-mono text-[9px] opacity-50">
                {place.id.slice(0, 6)}
              </span>
            </button>
          ))}

          {!isFetching && places?.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No open Studio places found.
            </div>
          ) : null}

          {isError ? (
            <div className="px-2 py-2 text-[10px] text-destructive">{error.message}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
