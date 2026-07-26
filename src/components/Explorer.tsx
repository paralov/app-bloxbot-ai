import {
  Box,
  Boxes,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudSun,
  Code2,
  Database,
  Folder,
  Gamepad2,
  type LucideIcon,
  PanelTop,
  ScrollText,
  Server,
  Sparkles,
  Users,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createExplorerReference,
  type ExplorerCollection,
  type ExplorerField,
  type ExplorerNode,
  generateExplorerCollection,
  replayExplorerCollector,
} from "@/lib/explorer";
import { splitModelKey } from "@/lib/splitModelKey";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";

const SYNC_INTERVAL_MS = 20_000;

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

const CLASS_ICONS: ReadonlyArray<[RegExp, LucideIcon]> = [
  [/^(Workspace|WorldRoot)$/, Gamepad2],
  [/^(Players|Player)$/, Users],
  [/^(Lighting|Atmosphere|Sky|Clouds)$/, CloudSun],
  [/^(ReplicatedStorage|ServerStorage|DataStoreService)$/, Database],
  [/^(ServerScriptService|Script|LocalScript|ModuleScript)$/, Code2],
  [/^(StarterGui|ScreenGui|SurfaceGui|BillboardGui|GuiObject|Frame)$/, PanelTop],
  [/^(Folder|Configuration)$/, Folder],
  [/^(Model|PVInstance)$/, Boxes],
  [/^(Part|MeshPart|UnionOperation|SpawnLocation|BasePart)$/, Box],
  [/^(Camera)$/, Camera],
  [/^(ParticleEmitter|Beam|Trail|Highlight)$/, Sparkles],
  [/^(RemoteEvent|RemoteFunction|BindableEvent|BindableFunction)$/, Server],
  [/^(StringValue|NumberValue|BoolValue|ObjectValue|ValueBase)$/, CircleDot],
  [/^(TextLabel|TextButton|TextBox)$/, ScrollText],
];

function iconForClass(className: string): LucideIcon {
  return CLASS_ICONS.find(([pattern]) => pattern.test(className))?.[1] ?? Box;
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
  const InstanceIcon = iconForClass(node.className);

  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={selectedPath === node.path}
        aria-expanded={canExpand ? isExpanded : undefined}
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
          <ChevronRight
            size={10}
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <button
          type="button"
          onClick={() => onSelect(node)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          title={`${node.path} · ${node.className}`}
        >
          <InstanceIcon
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-blue-600 dark:text-blue-400"
          />
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

function findNode(nodes: readonly ExplorerNode[], path: string): ExplorerNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = findNode(node.children, path);
    if (child) return child;
  }
  return null;
}

function freshnessLabel(capturedAt: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(capturedAt));
  if (!Number.isFinite(elapsed) || elapsed < 10_000) return "Just synced";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

export default function Explorer({ collapsed, onToggle }: ExplorerProps) {
  const { client } = useOpenCodeClient();
  const { selectedModel, selectedAgent } = usePreferences();
  const { referenceObject } = useExplorerReference();
  const [collection, setCollection] = useState<ExplorerCollection | null>(null);
  const collectionRef = useRef<ExplorerCollection | null>(null);
  const syncingRef = useRef(false);
  const resyncRequestedRef = useRef(false);
  const syncLatestRef = useRef<() => void>(() => undefined);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const model = useMemo(() => {
    if (!selectedModel) return undefined;
    const [providerID, modelID] = splitModelKey(selectedModel);
    return providerID && modelID ? { providerID, modelID } : undefined;
  }, [selectedModel]);

  useEffect(() => {
    if (!client || collapsed) return;
    const activeClient = client;
    let cancelled = false;

    async function sync() {
      if (syncingRef.current) {
        resyncRequestedRef.current = true;
        return;
      }
      if (document.visibilityState === "hidden") return;
      syncingRef.current = true;
      setSyncing(true);
      setSyncError(null);

      try {
        const current = collectionRef.current;
        let next: ExplorerCollection;
        if (current) {
          try {
            const snapshot = await replayExplorerCollector(
              activeClient,
              current.collector,
              model,
              selectedAgent,
            );
            next = { collector: current.collector, snapshot };
          } catch {
            next = await generateExplorerCollection(activeClient, model, selectedAgent);
          }
        } else {
          next = await generateExplorerCollection(activeClient, model, selectedAgent);
        }

        if (cancelled) return;
        collectionRef.current = next;
        setCollection(next);
        setNow(Date.now());
        setExpanded((currentExpanded) =>
          currentExpanded.size > 0
            ? currentExpanded
            : new Set(next.snapshot.roots.map((node) => node.path)),
        );
      } catch (error) {
        if (!cancelled) setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        syncingRef.current = false;
        if (!cancelled) setSyncing(false);
        if (resyncRequestedRef.current) {
          resyncRequestedRef.current = false;
          queueMicrotask(() => syncLatestRef.current());
        }
      }
    }

    syncLatestRef.current = () => void sync();
    void sync();
    const interval = window.setInterval(() => void sync(), SYNC_INTERVAL_MS);
    const freshness = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearInterval(freshness);
    };
  }, [client, collapsed, model, selectedAgent]);

  const toggleNode = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selected = useMemo(
    () => (selectedPath && collection ? findNode(collection.snapshot.roots, selectedPath) : null),
    [collection, selectedPath],
  );

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
          <Boxes size={15} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Boxes size={14} />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em]">Explorer</div>
            <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
              <span
                className={`h-1.5 w-1.5 rounded-full ${syncError ? "bg-amber-500" : syncing ? "animate-pulse bg-blue-500" : "bg-emerald-500"}`}
              />
              <span className="truncate">
                {syncing && !collection
                  ? "Building collector…"
                  : syncing
                    ? "Syncing…"
                    : syncError
                      ? "Retrying automatically"
                      : collection
                        ? freshnessLabel(collection.snapshot.capturedAt, now)
                        : "Waiting to sync"}
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse Explorer"
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft size={13} />
        </button>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        role="tree"
        aria-label="Instance hierarchy"
      >
        {!collection && syncing ? <ExplorerLoading /> : null}
        {!collection && syncError ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            Explorer will retry when Studio is available.
          </div>
        ) : null}
        {collection?.snapshot.roots.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggle={toggleNode}
            onSelect={(next) => setSelectedPath(next.path)}
          />
        ))}
      </div>

      {selected ? (
        <Inspector node={selected} onReference={handleReference} />
      ) : (
        <div className="shrink-0 border-t px-3 py-2 text-[9px] text-muted-foreground">
          Select an object to inspect and reference it.
        </div>
      )}
    </aside>
  );
}

function Inspector({ node, onReference }: { node: ExplorerNode; onReference: () => void }) {
  const InstanceIcon = iconForClass(node.className);
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto border-t bg-card/60">
      <div className="sticky top-0 border-b bg-card/95 p-3 backdrop-blur-sm">
        <div className="flex items-start gap-2">
          <InstanceIcon size={15} className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{node.name}</div>
            <div className="truncate font-mono text-[9px] text-muted-foreground" title={node.path}>
              {node.path}
            </div>
          </div>
          <button
            type="button"
            onClick={onReference}
            className="shrink-0 rounded-md bg-foreground px-2 py-1 text-[9px] font-medium text-background hover:opacity-90"
          >
            Reference
          </button>
        </div>
      </div>
      <FieldSection
        title="Properties"
        fields={[{ name: "ClassName", value: node.className }, ...node.properties]}
      />
      {node.attributes.length > 0 ? (
        <FieldSection title="Attributes" fields={node.attributes} />
      ) : null}
    </div>
  );
}

function FieldSection({ title, fields }: { title: string; fields: readonly ExplorerField[] }) {
  return (
    <section className="border-b px-3 py-2 last:border-b-0">
      <h4 className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <dl className="space-y-1">
        {fields.map((field) => (
          <div
            key={`${field.name}-${field.value}`}
            className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] gap-2 text-[10px]"
          >
            <dt className="truncate text-muted-foreground" title={field.name}>
              {field.name}
            </dt>
            <dd className="break-words font-mono text-foreground" title={field.value}>
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
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
