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
import {
  analyticsProperties,
  errorAnalyticsProperties,
  explorerAnalyticsProperties,
} from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import {
  createExplorerReference,
  type ExplorerField,
  type ExplorerNode,
  type ExplorerNodeDetails,
  type ExplorerSnapshot,
  formatFieldValue,
  sortExplorerSnapshot,
} from "@/lib/explorer";
import { notify } from "@/lib/notifications";
import { useExplorerReference } from "@/providers/ExplorerReferenceProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const ACTIVE_SYNC_MS = 2_500;
const IDLE_SYNC_MS = 5_000;
const MAX_UNCHANGED_SYNC_MS = 30_000;
// After failures, wait longer each time up to this, so a broken Studio setup
// doesn't retry every few seconds.
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;

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

export function iconForClass(className: string): LucideIcon {
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
        data-path={node.path}
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
        className={`group flex h-7 cursor-default items-center rounded-md pr-2 text-sm ${selectedPath === node.path ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={`${node.path} ${node.className}`}
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
          <InstanceIcon size={13} strokeWidth={1.8} className="shrink-0 text-muted-foreground/80" />
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
  const { referenceObject, publishObjects, focusRequest, consumeFocus } = useExplorerReference();
  const treeRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null);
  const snapshotRef = useRef<ExplorerSnapshot | null>(null);
  const syncingRef = useRef(false);
  const resyncRequestedRef = useRef(false);
  const syncLatestRef = useRef<() => void>(() => undefined);
  // The latest sync effect's scheduler, for a sync that finishes after its
  // own effect was replaced.
  const scheduleLatestRef = useRef<() => void>(() => {});
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const telemetryRef = useRef({ firstSyncReported: false, hadFailure: false });
  // Consecutive failed syncs, which set the retry backoff.
  const failuresRef = useRef(0);

  useEffect(() => {
    posthog.capture(
      collapsed ? "explorer_closed" : "explorer_opened",
      analyticsProperties("explorer", { collapsed }),
    );
  }, [collapsed]);

  // Reopening Explorer or switching Studio retries straight away. This lives outside the sync
  // effect, which also re-runs whenever the chat turns busy or idle and must not clear the backoff.
  const studioKey = studioTarget?.selected?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when Explorer opens or the Studio changes
  useEffect(() => {
    failuresRef.current = 0;
  }, [collapsed, studioKey]);

  useEffect(() => {
    if (!client || collapsed || !studioTarget?.selected) return;
    const studioId = studioTarget.selected.key;
    let cancelled = false;
    let timer: number | undefined;
    let unchangedPolls = 0;

    function scheduleNext() {
      if (cancelled) return;
      const baseDelay = sessionBusy ? ACTIVE_SYNC_MS : IDLE_SYNC_MS;
      const delay =
        failuresRef.current > 0
          ? Math.min(IDLE_SYNC_MS * 2 ** failuresRef.current, MAX_FAILURE_BACKOFF_MS)
          : Math.min(baseDelay * 2 ** Math.min(unchangedPolls, 3), MAX_UNCHANGED_SYNC_MS);
      // Replace any pending timer, so scheduling twice never runs two syncs.
      if (timer !== undefined) window.clearTimeout(timer);
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

      try {
        const current = snapshotRef.current;
        const next = sortExplorerSnapshot(await desktop.getExplorerSnapshot(studioId));
        if (!current && next.roots.length === 0) {
          throw new Error("Studio has not returned an instance tree yet");
        }

        if (cancelled) return;
        const previousComparable = current
          ? JSON.stringify({ placeName: current.placeName, roots: current.roots })
          : null;
        const nextComparable = JSON.stringify({
          placeName: next.placeName,
          roots: next.roots,
        });
        unchangedPolls = previousComparable === nextComparable ? unchangedPolls + 1 : 0;
        failuresRef.current = 0;
        snapshotRef.current = next;
        setSnapshot(next);
        publishObjects(next.roots);
        setExpanded((currentExpanded) =>
          currentExpanded.size > 0 ? currentExpanded : new Set(next.roots.map((node) => node.path)),
        );
        if (isFirstSync || telemetryRef.current.hadFailure) {
          posthog.capture(
            "sync_succeeded",
            analyticsProperties(
              "explorer",
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - syncStartedAt),
                source: telemetryRef.current.hadFailure ? "recovery" : "initial",
                root_count: next.roots.length,
                node_count: countNodes(next.roots),
              }),
            ),
          );
          telemetryRef.current.firstSyncReported = true;
          telemetryRef.current.hadFailure = false;
        }
      } catch (error) {
        console.error("[explorer] sync failed", error);
        telemetryRef.current.hadFailure = true;
        failuresRef.current += 1;
        // Report the first failure of a streak, not every retry.
        if (failuresRef.current === 1)
          posthog.capture(
            "sync_failed",
            errorAnalyticsProperties(
              "explorer",
              "sync",
              error,
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - syncStartedAt),
                reason: snapshotRef.current ? "recovery_failed" : "initial_failed",
              }),
            ),
          );
        if (!cancelled) setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        syncingRef.current = false;
        if (!cancelled) setSyncing(false);
        // A re-sync requested while this one ran waits for the backoff if
        // this one failed.
        if (resyncRequestedRef.current && failuresRef.current === 0) {
          resyncRequestedRef.current = false;
          queueMicrotask(() => syncLatestRef.current());
        } else {
          resyncRequestedRef.current = false;
          scheduleLatestRef.current();
        }
      }
    }

    syncLatestRef.current = () => void sync();
    scheduleLatestRef.current = scheduleNext;
    // This effect also re-runs when the chat turns busy or idle; during a
    // failure streak, wait for the backoff instead of retrying straight away.
    if (failuresRef.current > 0) scheduleNext();
    else void sync();
    const resume = () => {
      // While failing, wait for the backoff timer rather than retrying every time the window
      // regains focus.
      if (failuresRef.current > 0) return;
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
  }, [client, collapsed, publishObjects, sessionBusy, studioTarget?.selected]);

  const toggleNode = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!focusRequest || !snapshot) return;
    consumeFocus();
    if (!findNode(snapshot.roots, focusRequest)) return;
    setSearch("");
    setSelectedPath(focusRequest);
    setExpanded((current) => {
      const next = new Set(current);
      const parts = focusRequest.split(".");
      for (let depth = 1; depth < parts.length; depth++) {
        next.add(parts.slice(0, depth).join("."));
      }
      return next;
    });
  }, [focusRequest, snapshot, consumeFocus]);

  useEffect(() => {
    if (!selectedPath) return;
    treeRef.current
      ?.querySelector(`[data-path="${CSS.escape(selectedPath)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedPath]);

  const selected = useMemo(
    () => (selectedPath && snapshot ? findNode(snapshot.roots, selectedPath) : null),
    [snapshot, selectedPath],
  );

  const visibleRoots = useMemo(() => {
    if (!snapshot) return [];
    const query = search.trim().toLowerCase();
    if (!query) return snapshot.roots;
    const filter = (node: ExplorerNode): ExplorerNode | null => {
      const children = node.children.flatMap((child) => {
        const match = filter(child);
        return match ? [match] : [];
      });
      const matches = `${node.name} ${node.className} ${node.path}`.toLowerCase().includes(query);
      return matches || children.length > 0 ? { ...node, children } : null;
    };
    return snapshot.roots.flatMap((root) => {
      const match = filter(root);
      return match ? [match] : [];
    });
  }, [snapshot, search]);
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
        }),
      ),
    );
    notify.success(`${selected.name} added to your message`);
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
    <aside className="flex w-72 shrink-0 flex-col bg-sidebar">
      <header className="flex h-11 shrink-0 items-center justify-between px-3">
        <h2 className="text-sm font-medium text-muted-foreground">Explorer</h2>
        <button
          type="button"
          onClick={onToggle}
          className="flex h-6 w-6 items-center justify-center rounded text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close explorer"
        >
          ×
        </button>
      </header>

      <div className="px-3 pb-2 pt-1">
        <div className="flex h-8 items-center gap-2 rounded-md border bg-transparent px-2 text-muted-foreground focus-within:border-ring focus-within:text-foreground">
          <Search aria-hidden="true" size={12} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search instances"
            aria-label="Search Explorer"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {syncError ? (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          Explorer couldn’t load this Studio place. Trying again shortly.
        </div>
      ) : null}

      {snapshot?.truncated ? (
        <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          This place is too large to list in full, so some objects are missing here.
        </div>
      ) : null}

      <div
        ref={treeRef}
        className="min-h-0 flex-1 overflow-y-auto py-1"
        role="tree"
        aria-label="Instance hierarchy"
      >
        {!snapshot && syncing ? <ExplorerLoading /> : null}
        {!snapshot && !syncing && !syncError ? <ExplorerLoading /> : null}
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
        <Inspector
          node={selected}
          studioId={studioTarget?.selected?.key ?? null}
          onReference={handleReference}
        />
      ) : (
        <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
          Select an object to inspect and reference it.
        </div>
      )}
    </aside>
  );
}

function Inspector({
  node,
  studioId,
  onReference,
}: {
  node: ExplorerNode;
  studioId: string | null;
  onReference: () => void;
}) {
  const [details, setDetails] = useState<ExplorerNodeDetails | "loading" | "failed">("loading");
  useEffect(() => {
    if (!studioId) return;
    let current = true;
    setDetails("loading");
    desktop.getExplorerNodeDetails(studioId, node.path).then(
      (next) => {
        if (current) setDetails(next);
      },
      (error) => {
        console.error("[explorer] couldn't read object details", error);
        if (current) setDetails("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [studioId, node.path]);
  const loaded = typeof details === "object" ? details : null;
  const InstanceIcon = iconForClass(node.className);
  return (
    <div className="max-h-[42%] shrink-0 overflow-y-auto border-t bg-card/60">
      <div className="sticky top-0 border-b bg-card/95 p-3 backdrop-blur-sm">
        <div className="flex items-start gap-2">
          <InstanceIcon size={15} className="mt-0.5 shrink-0 text-muted-foreground/80" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{node.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={node.path}>
              {node.path}
            </div>
          </div>
          <button
            type="button"
            onClick={onReference}
            className="shrink-0 rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background hover:opacity-90"
          >
            Reference
          </button>
        </div>
      </div>
      <FieldSection
        title="Properties"
        fields={[{ name: "ClassName", value: node.className }, ...(loaded?.properties ?? [])]}
      />
      {details === "failed" ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          Couldn't read this object's properties from Studio.
        </p>
      ) : null}
      {loaded && loaded.attributes.length > 0 ? (
        <FieldSection title="Attributes" fields={loaded.attributes} />
      ) : null}
    </div>
  );
}

function FieldSection({ title, fields }: { title: string; fields: readonly ExplorerField[] }) {
  return (
    <section className="border-b px-3 py-2 last:border-b-0">
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h4>
      <dl className="space-y-1">
        {fields
          .filter((field) => field.value !== "")
          .map((field) => (
            <div
              key={`${field.name}-${field.value}`}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs"
            >
              <dt className="truncate text-muted-foreground" title={field.name}>
                {field.name}
              </dt>
              <dd className="truncate text-foreground tabular-nums" title={field.value}>
                {formatFieldValue(field.value)}
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
