import { useMutation } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { createExplorerReference, type ExplorerNode, loadExplorerSnapshot } from "@/lib/explorer";
import { splitModelKey } from "@/lib/splitModelKey";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

interface ExplorerProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface TreeRowProps {
  node: ExplorerNode;
  depth: number;
  expanded: ReadonlySet<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: ExplorerNode) => void;
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: TreeRowProps) {
  const isExpanded = expanded.has(node.path);
  const canExpand = node.hasChildren || node.children.length > 0;

  return (
    <>
      <div
        className={`group flex h-6 items-center pr-2 text-[11px] ${selectedPath === node.path ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
          disabled={!canExpand}
          onClick={() => onToggle(node.path)}
          className="flex h-5 w-4 shrink-0 items-center justify-center disabled:opacity-0"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 12 12"
            fill="none"
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          >
            <path d="m4 2.5 3.5 3.5L4 9.5" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${node.path} · ${node.className}`}
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] bg-blue-500/10 text-[8px] font-bold text-blue-600 dark:text-blue-400">
            {node.className.slice(0, 1).toUpperCase()}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
      </div>
      {isExpanded
        ? node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
});

export default function Explorer({ collapsed, onToggle }: ExplorerProps) {
  const { client } = useOpenCodeClient();
  const { selectedModel, selectedAgent } = usePreferences();
  const { referenceObject } = useExplorerReference();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<ExplorerNode | null>(null);

  const model = useMemo(() => {
    if (!selectedModel) return undefined;
    const [providerID, modelID] = splitModelKey(selectedModel);
    return providerID && modelID ? { providerID, modelID } : undefined;
  }, [selectedModel]);

  const snapshot = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error("BloxBot is still connecting");
      return loadExplorerSnapshot(client, model, selectedAgent);
    },
    onSuccess: (data) => {
      setSelected(null);
      setExpanded(new Set(data.roots.map((node) => node.path)));
    },
    onError: (error) => toast.error("Explorer couldn't refresh", { description: error.message }),
  });

  useEffect(() => {
    if (client && !snapshot.data && !snapshot.isPending && !snapshot.isError) snapshot.mutate();
  }, [client, snapshot]);

  const toggleNode = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectNode = useCallback((node: ExplorerNode) => setSelected(node), []);
  const handleReference = useCallback(() => {
    if (!selected) return;
    referenceObject(createExplorerReference(selected));
    toast.success(`${selected.name} added to your message`);
  }, [referenceObject, selected]);

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center border-l bg-sidebar py-2">
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Open Explorer"
        >
          <ExplorerIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <ExplorerIcon />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em]">Explorer</div>
            {snapshot.data ? (
              <div className="truncate text-[9px] text-muted-foreground">
                {snapshot.data.placeName}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => snapshot.mutate()}
            disabled={snapshot.isPending}
            aria-label="Refresh Explorer"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <RefreshIcon spinning={snapshot.isPending} />
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse Explorer"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        role="tree"
        aria-label="Instance hierarchy"
      >
        {snapshot.isPending ? <ExplorerLoading /> : null}
        {snapshot.isError ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            <p>Couldn't read the place.</p>
            <button
              type="button"
              onClick={() => snapshot.mutate()}
              className="mt-2 font-medium text-foreground underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        ) : null}
        {snapshot.data?.roots.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            selectedPath={selected?.path ?? null}
            onToggle={toggleNode}
            onSelect={selectNode}
          />
        ))}
      </div>

      {selected ? (
        <div className="shrink-0 border-t bg-card/60 p-3">
          <div className="truncate text-xs font-medium">{selected.name}</div>
          <div
            className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground"
            title={selected.path}
          >
            {selected.path}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
              {selected.className}
            </span>
            <button
              type="button"
              onClick={handleReference}
              className="rounded-md bg-foreground px-2 py-1 text-[10px] font-medium text-background hover:opacity-90"
            >
              Reference in chat
            </button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t px-3 py-2 text-[9px] text-muted-foreground">
          Select an object to reference it in chat.
        </div>
      )}
    </aside>
  );
}

function ExplorerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={spinning ? "animate-spin" : ""}
    >
      <path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5" />
    </svg>
  );
}

function ExplorerLoading() {
  return (
    <div className="space-y-1.5 px-3 py-3">
      {[78, 62, 85, 70, 58, 81].map((width, index) => (
        <div
          key={width}
          className="h-4 animate-pulse rounded bg-muted"
          style={{ width: `${width}%`, marginLeft: `${(index % 3) * 10}px` }}
        />
      ))}
    </div>
  );
}
