import {
  Box,
  Boxes,
  Camera,
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
  Search,
  Server,
  Sparkles,
  Users,
} from "lucide-react";
import posthog from "posthog-js/dist/module.full.no-external.js";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  analyticsProperties,
  errorAnalyticsProperties,
  explorerAnalyticsProperties,
} from "@/lib/analytics";
import { BUILTIN_EXPLORER_PROGRAM } from "@/lib/builtinStudioPrograms";
import { desktop } from "@/lib/desktop";
import {
  createExplorerReference,
  type ExplorerCollection,
  type ExplorerField,
  type ExplorerNode,
  type ExplorerProgramEnvelope,
  generateExplorerProgram,
} from "@/lib/explorer";
import { splitModelKey } from "@/lib/splitModelKey";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const ACTIVE_SYNC_MS = 2_500;
const IDLE_SYNC_MS = 5_000;
const MAX_UNCHANGED_SYNC_MS = 30_000;

interface ExplorerProps {
  collapsed: boolean;
  sessionBusy: boolean;
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
        onClick={() => onSelect(node)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(node);
          }
        }}
        className={`group flex h-6 cursor-default items-center pr-2 text-[11px] ${selectedPath === node.path ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={`${node.path} · ${node.className}`}
      >
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
          disabled={!canExpand}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(node.path);
          }}
          className="flex h-5 w-4 shrink-0 items-center justify-center disabled:opacity-0"
        >
          <ChevronRight
            size={10}
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
        </button>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <InstanceIcon
            size={13}
            strokeWidth={1.8}
            className="shrink-0 text-blue-600 dark:text-blue-400"
          />
          <span className="truncate">{node.name}</span>
        </span>
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

function countNodes(nodes: readonly ExplorerNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function collectPaths(nodes: readonly ExplorerNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (node: ExplorerNode) => {
    paths.add(node.path);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return paths;
}

export default function Explorer({ collapsed, sessionBusy, onToggle }: ExplorerProps) {
  const { client } = useOpenCodeClient();
  const studioTarget = useStudioTargetOptional();
  const { selectedModel, selectedAgent } = usePreferences();
  const { referenceObject } = useExplorerReference();
  const [collection, setCollection] = useState<ExplorerCollection | null>(null);
  const collectionRef = useRef<ExplorerCollection | null>(null);
  const syncingRef = useRef(false);
  const resyncRequestedRef = useRef(false);
  const syncLatestRef = useRef<() => void>(() => undefined);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const telemetryRef = useRef({ firstSyncReported: false, hadFailure: false });
  const generationBlockedRef = useRef(false);

  const model = useMemo(() => {
    if (!selectedModel) return undefined;
    const [providerID, modelID] = splitModelKey(selectedModel);
    return providerID && modelID ? { providerID, modelID } : undefined;
  }, [selectedModel]);

  useEffect(() => {
    posthog.capture(
      collapsed ? "explorer_closed" : "explorer_opened",
      analyticsProperties("explorer", { collapsed }),
    );
  }, [collapsed]);

  useEffect(() => {
    if (!client || collapsed || !studioTarget?.selected) return;
    const activeClient = client;
    let cancelled = false;
    let timer: number | undefined;
    let unchangedPolls = 0;

    function scheduleNext() {
      if (cancelled) return;
      const baseDelay = sessionBusy ? ACTIVE_SYNC_MS : IDLE_SYNC_MS;
      const delay = Math.min(baseDelay * 2 ** Math.min(unchangedPolls, 3), MAX_UNCHANGED_SYNC_MS);
      timer = window.setTimeout(() => void sync(), delay);
    }

    async function sync() {
      if (syncingRef.current) {
        resyncRequestedRef.current = true;
        return;
      }
      if (document.visibilityState === "hidden" || !document.hasFocus()) {
        scheduleNext();
        return;
      }
      syncingRef.current = true;
      setSyncing(true);
      setSyncError(null);
      const syncStartedAt = performance.now();
      const isFirstSync = !telemetryRef.current.firstSyncReported;
      if (isFirstSync) {
        posthog.capture("sync_started", analyticsProperties("explorer", { source: "initial" }));
      }

      async function generate(reason: "initial" | "contract_recovery") {
        const startedAt = performance.now();
        posthog.capture(
          "collector_generation_started",
          analyticsProperties("explorer", { model_mediated: true, reason }),
        );
        try {
          const program: ExplorerProgramEnvelope =
            reason === "initial"
              ? BUILTIN_EXPLORER_PROGRAM
              : await generateExplorerProgram(activeClient, model, selectedAgent);
          const artifact = await desktop.compileExplorerProgram(program);
          const snapshot = await desktop.invokeExplorerProgram(artifact);
          if (snapshot.roots.length === 0) {
            throw new Error("Studio has not returned an instance tree yet");
          }
          const generated: ExplorerCollection = { program, artifact, snapshot };
          posthog.capture(
            "collector_generation_succeeded",
            analyticsProperties(
              "explorer",
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - startedAt),
                model_mediated: true,
                reason,
                root_count: generated.snapshot.roots.length,
                node_count: countNodes(generated.snapshot.roots),
              }),
            ),
          );
          return generated;
        } catch (error) {
          console.error("[explorer] collector generation failed", error);
          posthog.capture(
            "collector_generation_failed",
            errorAnalyticsProperties(
              "explorer",
              "collector_generation",
              error,
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - startedAt),
                model_mediated: true,
                reason,
              }),
            ),
          );
          throw error;
        }
      }

      try {
        const current = collectionRef.current;
        let next: ExplorerCollection;
        if (current) {
          try {
            const snapshot = await desktop.invokeExplorerProgram(current.artifact);
            next = { ...current, snapshot };
          } catch (error) {
            telemetryRef.current.hadFailure = true;
            posthog.capture(
              "sync_failed",
              errorAnalyticsProperties("explorer", "collector_runtime", error, {
                reason: "collector_runtime",
              }),
            );
            next = await generate("contract_recovery");
          }
        } else if (!generationBlockedRef.current) {
          next = await generate("initial");
        } else {
          throw new Error("Explorer setup needs repair before it can retry.");
        }

        if (cancelled) return;
        const previousComparable = current
          ? JSON.stringify({ placeName: current.snapshot.placeName, roots: current.snapshot.roots })
          : null;
        const nextComparable = JSON.stringify({
          placeName: next.snapshot.placeName,
          roots: next.snapshot.roots,
        });
        unchangedPolls = previousComparable === nextComparable ? unchangedPolls + 1 : 0;
        collectionRef.current = next;
        setCollection(next);
        setExpanded((currentExpanded) =>
          currentExpanded.size > 0
            ? currentExpanded
            : new Set(next.snapshot.roots.map((node) => node.path)),
        );
        if (isFirstSync || telemetryRef.current.hadFailure) {
          posthog.capture(
            "sync_succeeded",
            analyticsProperties(
              "explorer",
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - syncStartedAt),
                source: telemetryRef.current.hadFailure ? "recovery" : "initial",
                root_count: next.snapshot.roots.length,
                node_count: countNodes(next.snapshot.roots),
              }),
            ),
          );
          telemetryRef.current.firstSyncReported = true;
          telemetryRef.current.hadFailure = false;
        }
      } catch (error) {
        console.error("[explorer] sync failed", error);
        if (!collectionRef.current) generationBlockedRef.current = true;
        telemetryRef.current.hadFailure = true;
        posthog.capture(
          "sync_failed",
          errorAnalyticsProperties(
            "explorer",
            "sync",
            error,
            explorerAnalyticsProperties({
              duration_ms: Math.round(performance.now() - syncStartedAt),
              reason: collectionRef.current ? "recovery_failed" : "initial_failed",
            }),
          ),
        );
        if (!cancelled) setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        syncingRef.current = false;
        if (!cancelled) setSyncing(false);
        if (resyncRequestedRef.current) {
          resyncRequestedRef.current = false;
          queueMicrotask(() => syncLatestRef.current());
        } else scheduleNext();
      }
    }

    syncLatestRef.current = () => void sync();
    void sync();
    const resume = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        if (timer !== undefined) window.clearTimeout(timer);
        void sync();
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [client, collapsed, model, selectedAgent, sessionBusy, studioTarget?.selected]);

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

  const visibleRoots = useMemo(() => {
    if (!collection) return [];
    const query = search.trim().toLowerCase();
    if (!query) return collection.snapshot.roots;
    const filter = (node: ExplorerNode): ExplorerNode | null => {
      const children = node.children.flatMap((child) => {
        const match = filter(child);
        return match ? [match] : [];
      });
      const matches = `${node.name} ${node.className} ${node.path}`.toLowerCase().includes(query);
      return matches || children.length > 0 ? { ...node, children } : null;
    };
    return collection.snapshot.roots.flatMap((root) => {
      const match = filter(root);
      return match ? [match] : [];
    });
  }, [collection, search]);
  const visibleExpanded = useMemo(
    () => (search.trim() ? collectPaths(visibleRoots) : expanded),
    [expanded, search, visibleRoots],
  );

  const handleReference = useCallback(() => {
    if (!selected) return;
    referenceObject(createExplorerReference(selected));
    posthog.capture(
      "reference_added",
      analyticsProperties(
        "explorer",
        explorerAnalyticsProperties({
          class_category: iconForClass(selected.className) === Box ? "generic" : "known",
          has_attributes: selected.attributes.length > 0,
        }),
      ),
    );
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
    <aside className="animate-in slide-in-from-right-4 flex w-72 shrink-0 flex-col border-l bg-sidebar duration-200">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-5">
        <div>
          <h2 className="font-serif text-xl">Explorer</h2>
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="rounded-md px-2 py-1 text-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close explorer"
        >
          ×
        </button>
      </header>

      <div className="px-3 pb-2 pt-1">
        <div className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-muted-foreground focus-within:border-ring focus-within:text-foreground">
          <Search aria-hidden="true" size={12} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search instances"
            aria-label="Search Explorer"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {syncError ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[10px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          Explorer couldn’t load this Studio place. Close and reopen Explorer to retry.
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        role="tree"
        aria-label="Instance hierarchy"
      >
        {!collection && syncing ? <ExplorerLoading /> : null}
        {!collection && !syncing && !syncError ? <ExplorerLoading /> : null}
        {visibleRoots.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={visibleExpanded}
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
