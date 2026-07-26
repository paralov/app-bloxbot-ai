import { toast } from "sonner";

import { useStudioAssignments } from "@/hooks/useStudioAssignments";
import { useStudioPlaces } from "@/hooks/useStudioPlaces";

export default function StudioPlacePicker({
  sessionID,
  disabled = false,
}: {
  sessionID: string;
  disabled?: boolean;
}) {
  const { assignments, setAssignment } = useStudioAssignments();
  const { data: places = [], isFetching, refetch } = useStudioPlaces();
  const assignment = assignments[sessionID];
  const connected = !assignment || places.some((place) => place.id === assignment.id);

  const choose = async (studioID: string) => {
    const place = places.find((candidate) => candidate.id === studioID) ?? null;
    try {
      await setAssignment(sessionID, place && { id: place.id, name: place.name });
    } catch (error) {
      toast.error("Studio place change failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <label
      className={`flex min-w-0 items-center gap-1.5 text-[10px] ${
        connected ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"
      }`}
      title={disabled ? "Wait for this session to finish before changing places" : undefined}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          assignment && connected ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
      />
      <select
        aria-label="Roblox Studio place"
        value={assignment?.id ?? ""}
        disabled={disabled}
        onFocus={() => void refetch()}
        onChange={(event) => void choose(event.target.value)}
        className="max-w-56 truncate rounded-md bg-transparent py-1 outline-none hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <option value="">Automatic selection</option>
        {assignment && !connected ? <option value={assignment.id}>{assignment.name}</option> : null}
        {places.map((place) => (
          <option key={place.id} value={place.id}>
            {place.name} · {place.id.slice(0, 6)}
          </option>
        ))}
      </select>
      {isFetching ? <span>Checking…</span> : null}
    </label>
  );
}
