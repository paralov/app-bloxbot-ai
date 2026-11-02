import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ModelStatusBadge from "@/components/ModelStatusBadge";
import { MenuItem, MenuLabel, MenuSearch } from "@/components/ui/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Model } from "@/lib/opencode/types";

/** Past this many models the picker offers a search box. */
const SEARCH_THRESHOLD = 8;

/**
 * The Check button for a connected provider. It opens a list of the
 * provider's chat models so the user can pick the one to test, since only
 * they know which models their plan includes. The first listed model is
 * picked to start with. Open state is controlled so other actions, like the
 * toast after connecting, can open it too.
 */
export default function ProviderCheckPopover({
  providerName,
  models,
  checking,
  open,
  onOpenChange,
  onCheck,
}: {
  providerName: string;
  /** The provider's chat models, the preselected one first. */
  models: Model[];
  checking: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCheck: (model: Model) => void;
}) {
  const [pickedId, setPickedId] = useState<string>();
  const [search, setSearch] = useState("");

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle ? models.filter((m) => `${m.name} ${m.id}`.toLowerCase().includes(needle)) : models,
    [models, needle],
  );
  // The Check button always names a model the list is showing.
  const picked = visible.find((m) => m.id === pickedId) ?? visible[0];

  // Each opening starts from the preselected model with no search. A model
  // list refresh while open keeps the user's pick.
  const firstId = models[0]?.id;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPickedId(firstId);
      setSearch("");
    }
    wasOpen.current = open;
  }, [open, firstId]);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={checking}
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          title="Send one short test message to check this connection"
        >
          {checking && <Loader2 className="h-3 w-3 animate-spin" />}
          {checking ? "Checking" : "Check"}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        // cn() doesn't merge classes, so the default p-1 needs overriding.
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] w-72 max-w-[calc(100vw-2rem)] flex-col p-0!"
      >
        <div className="shrink-0 px-3 pt-2.5 pb-2">
          <div className="text-sm font-medium">Check {providerName}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Pick a model to send one short test message to.
          </p>
        </div>
        {models.length > SEARCH_THRESHOLD ? (
          <div className="border-t">
            <MenuSearch value={search} onChange={setSearch} placeholder="Search models..." />
          </div>
        ) : null}
        <div
          role="listbox"
          aria-label="Model to check"
          className={`min-h-0 flex-1 overflow-y-auto p-1 ${models.length > SEARCH_THRESHOLD ? "" : "border-t"}`}
        >
          {visible.map((model) => {
            const isPicked = model.id === picked?.id;
            return (
              <MenuItem
                key={model.id}
                role="option"
                aria-selected={isPicked}
                checked={isPicked}
                onClick={() => setPickedId(model.id)}
              >
                <span className="truncate">{model.name}</span>
                <ModelStatusBadge status={model.status} />
              </MenuItem>
            );
          })}
          {models.length === 0 && (
            <MenuLabel className="text-center">
              This provider has no chat models to test with.
            </MenuLabel>
          )}
          {models.length > 0 && visible.length === 0 && (
            <MenuLabel className="text-center">No models matching "{search.trim()}"</MenuLabel>
          )}
        </div>
        {picked && (
          <div className="shrink-0 border-t p-2">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onCheck(picked);
              }}
              className="w-full truncate rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Check {picked.name}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
