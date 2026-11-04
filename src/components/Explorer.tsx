import { useVirtualizer } from "@tanstack/react-virtual";
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
import {
  type MouseEvent,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuItem,
  InlineEdit,
  menuPosition,
} from "@/components/ExplorerControls";
import { type FieldChange, Inspector } from "@/components/ExplorerInspector";
import {
  analyticsProperties,
  errorAnalyticsProperties,
  explorerAnalyticsProperties,
} from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import {
  canEditObject,
  type ExplorerEdit,
  type ExplorerNode,
  type ExplorerWait,
  explorerRows,
  nodeId,
  OBJECT_DRAG_NAME_TYPE,
  OBJECT_DRAG_TYPE,
  renamedId,
  siblingPath,
} from "@/lib/explorer";
import { notify } from "@/lib/notifications";
import { useExplorerReference, useExplorerTree } from "@/providers/ExplorerReferenceProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const ROW_HEIGHT = 28;

const WAITING_NOTICES: Record<ExplorerWait, string> = {
  studio_closed: "Studio closed · Reconnects when it's back",
  no_place: "No place open · Open one in Studio",
  mode_changed: "Studio changing modes · Back in a moment",
  place_loading: "Place still loading · Back in a moment",
};

interface ExplorerProps {
  collapsed: boolean;
  sessionBusy: boolean;
  onToggle: () => void;
}

interface TreeRowProps {
  node: ExplorerNode;
  depth: number;
  position: number;
  siblings: number;
  start: number;
  isExpanded: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: ExplorerNode) => void;
  onOpenMenu: (event: MouseEvent, node: ExplorerNode) => void;
  onRenamed: (node: ExplorerNode, name: string | null) => void;
  onDroppedInChat: (node: ExplorerNode) => void;
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
  position,
  siblings,
  start,
  isExpanded,
  isSelected,
  isRenaming,
  onToggle,
  onSelect,
  onOpenMenu,
  onRenamed,
  onDroppedInChat,
}: TreeRowProps) {
  const id = nodeId(node);
  const canExpand = node.hasChildren || node.children.length > 0;
  const InstanceIcon = iconForClass(node.className);

  return (
    <div
      role="treeitem"
      data-path={node.path}
      data-id={id}
      tabIndex={0}
      draggable={!isRenaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(OBJECT_DRAG_TYPE, node.path);
        event.dataTransfer.setData(OBJECT_DRAG_NAME_TYPE, node.name);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={(event) => {
        // The message box is the only place that accepts this drag.
        if (event.dataTransfer.dropEffect !== "none") onDroppedInChat(node);
      }}
      aria-level={depth + 1}
      aria-posinset={position}
      aria-setsize={siblings}
      aria-selected={isSelected}
      aria-expanded={canExpand ? isExpanded : undefined}
      onClick={() => onSelect(node)}
      onContextMenu={(event) => onOpenMenu(event, node)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node);
        }
      }}
      className={`group absolute top-0 left-0 flex h-7 w-full cursor-default items-center rounded-md pr-2 text-sm ${isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
      style={{ paddingLeft: `${8 + depth * 14}px`, transform: `translateY(${start}px)` }}
      title={`${node.path} ${node.className}`}
    >
      <button
        type="button"
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
        disabled={!canExpand}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(id);
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
        {isRenaming ? (
          <InlineEdit
            value={node.name}
            label={`Rename ${node.name}`}
            maxLength={100}
            className="flex-1 text-sm"
            onDone={(name) => onRenamed(node, name)}
          />
        ) : (
          <span className="truncate">{node.name}</span>
        )}
      </span>
    </div>
  );
});

function countNodes(nodes: readonly ExplorerNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

/** The chain of objects down to the first one at a path, which a link in the chat names. */
function chainToPath(nodes: readonly ExplorerNode[], path: string): ExplorerNode[] | null {
  for (const node of nodes) {
    if (node.path === path) return [node];
    const rest = chainToPath(node.children, path);
    if (rest) return [node, ...rest];
  }
  return null;
}

function collectPaths(nodes: readonly ExplorerNode[]): Set<string> {
  const paths = new Set<string>();
  const visit = (node: ExplorerNode) => {
    paths.add(nodeId(node));
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return paths;
}

/** Replaces a renamed object's path, and the same start on everything inside it. */
function movedPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(`${from}.`) ? `${to}${path.slice(from.length)}` : path;
}

const EDIT_VERBS: Record<ExplorerEdit["action"], string> = {
  rename: "rename",
  duplicate: "duplicate",
  delete: "delete",
  setField: "change",
  addAttribute: "add an attribute to",
  removeAttribute: "remove an attribute from",
  addTag: "add a tag to",
  removeTag: "remove a tag from",
};

function editErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Stop the playtest first")) return "Stop the playtest first.";
  if (message.includes("That value doesn't fit this field")) {
    return "That value doesn't fit this field.";
  }
  if (message.includes("BloxBot can't edit this kind of value")) {
    return "BloxBot can't edit this kind of value yet.";
  }
  if (message.includes("This attribute already exists")) return "This attribute already exists.";
  if (!/Found \d+ objects at this path/.test(message)) return "Studio didn't allow this.";
  return "The place has changed since this was read, so nothing was edited. Try again in a moment.";
}

export default function Explorer({ collapsed, sessionBusy, onToggle }: ExplorerProps) {
  const studioTarget = useStudioTargetOptional();
  const { referenceObject, focusRequest, focusObject, consumeFocus } = useExplorerReference();
  const { tree, truncated, syncing, syncError, waiting, setDemand, requestSync } =
    useExplorerTree();
  const treeRef = useRef<HTMLDivElement>(null);
  // An object each time, so a second click on the same link still scrolls to it.
  const [scrollTarget, setScrollTarget] = useState<{ id: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<{ node: ExplorerNode; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerNode | null>(null);
  const studioId = studioTarget?.selected?.key;
  const openedStudioRef = useRef<string | undefined>(undefined);
  const latestTreeRef = useRef(tree);
  latestTreeRef.current = tree;

  useEffect(() => {
    posthog.capture(
      collapsed ? "explorer_closed" : "explorer_opened",
      analyticsProperties("explorer", { collapsed }),
    );
  }, [collapsed]);

  useEffect(() => {
    setDemand({ open: !collapsed, busy: sessionBusy });
    // Settings takes this panel's place, and nothing there needs the tree kept up to date.
    return () => setDemand({ open: false, busy: false });
  }, [collapsed, sessionBusy, setDemand]);

  // A place opens with its services showing, once.
  useEffect(() => {
    if (!tree?.roots.length || openedStudioRef.current === studioId) return;
    openedStudioRef.current = studioId;
    setExpanded(new Set(tree.roots.map(nodeId)));
  }, [tree, studioId]);

  const selectNode = useCallback((node: ExplorerNode) => setSelectedId(nodeId(node)), []);

  const toggleNode = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    // A reply can link to an object before this panel's next sync has it, so the request waits.
    const chain = focusRequest && tree ? chainToPath(tree.roots, focusRequest) : null;
    if (!chain) return;
    consumeFocus();
    setSearch("");
    const ids = chain.map(nodeId);
    setSelectedId(ids[ids.length - 1]);
    setScrollTarget({ id: ids[ids.length - 1] });
    setExpanded((current) => new Set([...current, ...ids.slice(0, -1)]));
  }, [focusRequest, tree, consumeFocus]);

  const selected = selectedId ? (tree?.byId.get(selectedId) ?? null) : null;

  // Typing stays quick in a big place, with the list catching up behind it.
  const query = useDeferredValue(search).trim().toLowerCase();
  const visibleRoots = useMemo(() => {
    if (!tree) return [];
    if (!query) return tree.roots;
    const filter = (node: ExplorerNode): ExplorerNode | null => {
      const children = node.children.flatMap((child) => {
        const match = filter(child);
        return match ? [match] : [];
      });
      const matches = `${node.name} ${node.className} ${node.path}`.toLowerCase().includes(query);
      return matches || children.length > 0 ? { ...node, children } : null;
    };
    return tree.roots.flatMap((root) => {
      const match = filter(root);
      return match ? [match] : [];
    });
  }, [tree, query]);
  const visibleExpanded = useMemo(
    () => (query ? collectPaths(visibleRoots) : expanded),
    [expanded, query, visibleRoots],
  );
  const rows = useMemo(
    () => explorerRows(visibleRoots, visibleExpanded),
    [visibleRoots, visibleExpanded],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  useEffect(() => {
    if (!scrollTarget) return;
    const index = rows.findIndex((row) => !row.loading && nodeId(row.node) === scrollTarget.id);
    // The rows of what a link just expanded arrive with the next render.
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    setScrollTarget(null);
  }, [scrollTarget, rows, virtualizer]);

  const captureReference = useCallback((node: ExplorerNode, source: "drag" | "menu") => {
    posthog.capture(
      "reference_added",
      analyticsProperties(
        "explorer",
        explorerAnalyticsProperties({
          class_category: iconForClass(node.className) === Box ? "generic" : "known",
          source,
        }),
      ),
    );
  }, []);
  const handleDroppedInChat = useCallback(
    (node: ExplorerNode) => captureReference(node, "drag"),
    [captureReference],
  );

  const openMenu = useCallback((event: MouseEvent, node: ExplorerNode) => {
    event.preventDefault();
    setSelectedId(nodeId(node));
    setMenu({ node, ...menuPosition(event) });
    posthog.capture("object_menu_opened", analyticsProperties("explorer"));
  }, []);

  const copyPath = async (node: ExplorerNode) => {
    try {
      await navigator.clipboard.writeText(node.path);
      notify.success("Path copied");
    } catch {
      notify.error("Couldn't copy the path");
    }
  };

  const editObject = useCallback(
    async (
      node: ExplorerNode,
      edit: { action: "rename"; name: string } | { action: "duplicate" | "delete" } | FieldChange,
      onDone: (name: string) => void,
    ) => {
      if (!studioId) return;
      const request = {
        ...edit,
        path: node.path,
        className: node.className,
        occurrence: node.occurrence,
        occurrences: node.occurrences,
      } as ExplorerEdit;
      try {
        const { name } = await desktop.editExplorerObject(studioId, request);
        posthog.capture("object_edited", analyticsProperties("explorer", { action: edit.action }));
        onDone(name);
        requestSync({ force: true });
      } catch (error) {
        console.error(`[explorer] couldn't ${edit.action} an object`, error);
        posthog.capture(
          "object_edit_failed",
          errorAnalyticsProperties("explorer", edit.action, error),
        );
        notify.error(`Couldn't ${EDIT_VERBS[edit.action]} ${node.name}`, {
          description: editErrorMessage(error),
        });
      }
    },
    [studioId, requestSync],
  );

  const handleRenamed = useCallback(
    (node: ExplorerNode, name: string | null) => {
      setRenamingId(null);
      const next = name?.trim();
      if (!next || next === node.name) return;
      void editObject(node, { action: "rename", name: next }, (renamed) => {
        const from = nodeId(node);
        const to = renamedId(node, renamed);
        // A sibling already has that id, and the next read decides which of them gets it. Following
        // it could leave the panel editing the other object.
        if (latestTreeRef.current?.byId.has(to)) {
          setSelectedId((current) =>
            current === from || current?.startsWith(`${from}.`) ? null : current,
          );
          return;
        }
        setSelectedId((current) => current && movedPath(current, from, to));
        setExpanded((current) => new Set([...current].map((id) => movedPath(id, from, to))));
      });
    },
    [editObject],
  );

  const handleDelete = (node: ExplorerNode) => {
    setDeleteTarget(null);
    void editObject(node, { action: "delete" }, () => {
      setSelectedId((current) =>
        current === nodeId(node) || current?.startsWith(`${nodeId(node)}.`) ? null : current,
      );
    });
  };

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

      {waiting ? (
        <output className="block shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          {WAITING_NOTICES[waiting]}
        </output>
      ) : null}

      {truncated ? (
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
        {!tree && !waiting && (syncing || !syncError) ? <ExplorerLoading /> : null}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const id = nodeId(row.node);
            if (row.loading) {
              return (
                <div
                  key={`${id} loading`}
                  className="absolute top-0 left-0 flex h-7 w-full items-center text-xs text-muted-foreground"
                  style={{
                    paddingLeft: `${28 + row.depth * 14}px`,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  Loading...
                </div>
              );
            }
            return (
              <TreeRow
                key={id}
                node={row.node}
                depth={row.depth}
                position={row.position}
                siblings={row.siblings}
                start={item.start}
                isExpanded={visibleExpanded.has(id)}
                isSelected={selectedId === id}
                isRenaming={renamingId === id}
                onToggle={toggleNode}
                onSelect={selectNode}
                onOpenMenu={openMenu}
                onRenamed={handleRenamed}
                onDroppedInChat={handleDroppedInChat}
              />
            );
          })}
        </div>
      </div>

      {selected ? (
        <Inspector
          node={selected}
          studioId={studioId ?? null}
          onReference={(reference) => {
            referenceObject(reference);
            captureReference(selected, "menu");
          }}
          onChange={(change, onDone) => void editObject(selected, change, onDone)}
          onRename={(name) => handleRenamed(selected, name)}
        />
      ) : (
        <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
          Select an object to see its details, or drag it into your message.
        </div>
      )}

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`Actions for ${menu.node.name}`}
          onClose={() => setMenu(null)}
        >
          <ContextMenuItem
            onClick={() => {
              referenceObject(menu.node);
              captureReference(menu.node, "menu");
              setMenu(null);
            }}
          >
            Reference in chat
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              void copyPath(menu.node);
              setMenu(null);
            }}
          >
            Copy path
          </ContextMenuItem>
          {canEditObject(menu.node) ? (
            <>
              <div className="my-1 h-px bg-border" />
              <ContextMenuItem
                onClick={() => {
                  setRenamingId(nodeId(menu.node));
                  setMenu(null);
                }}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => {
                  const { node } = menu;
                  setMenu(null);
                  void editObject(node, { action: "duplicate" }, (name) =>
                    focusObject(siblingPath(node, name)),
                  );
                }}
              >
                Duplicate
              </ContextMenuItem>
              <ContextMenuItem
                className="text-destructive"
                onClick={() => {
                  // While searching, this row only holds the children that match.
                  setDeleteTarget(tree?.byId.get(nodeId(menu.node)) ?? menu.node);
                  setMenu(null);
                }}
              >
                Delete
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenu>
      ) : null}

      {deleteTarget ? (
        <DeleteObjectDialog
          node={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
        />
      ) : null}
    </aside>
  );
}

function DeleteObjectDialog({
  node,
  onCancel,
  onConfirm,
}: {
  node: ExplorerNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const inside = countNodes(node.children);
  return createPortal(
    <div
      className="animate-lightbox-backdrop fixed inset-0 z-[300] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-object-title"
        aria-describedby="delete-object-description"
        className="animate-scale-in w-full max-w-sm rounded-xl border bg-card p-5 text-card-foreground shadow-2xl"
      >
        <h2 id="delete-object-title" className="text-base font-medium">
          Delete {node.name}?
        </h2>
        <p
          id="delete-object-description"
          className="mt-1.5 text-xs leading-relaxed text-muted-foreground"
        >
          {node.pending
            ? "This removes it and everything inside it from your place."
            : inside > 0
              ? `This removes it and the ${inside === 1 ? "object" : `${inside} objects`} inside it from your place.`
              : "This removes it from your place."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
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
