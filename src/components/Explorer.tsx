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
  type KeyboardEvent as ReactKeyboardEvent,
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
  EXPLORER_LONG_WAIT_NOTICES,
  EXPLORER_WAIT_NOTICES,
  type ExplorerEdit,
  type ExplorerNode,
  explorerRows,
  nodeId,
  OBJECT_DRAG_NAME_TYPE,
  OBJECT_DRAG_TYPE,
  renamedId,
  siblingPath,
} from "@/lib/explorer";
import { notify } from "@/lib/notifications";
import {
  useExplorerReference,
  useExplorerTree,
  useExplorerView,
} from "@/providers/ExplorerReferenceProvider";
import { placeName, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

const ROW_HEIGHT = 28;
// How long a row that was scrolled to gets to show up before focus stops waiting for it.
const FOCUS_ROW_FRAMES = 10;
const EDIT_DONE: Record<string, string> = {
  rename: "Renamed",
  duplicate: "Duplicated",
  delete: "Deleted",
};

const LONG_WAIT_MS = 30_000;

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
  isTabStop: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: ExplorerNode) => void;
  onOpenMenu: (event: MouseEvent, node: ExplorerNode) => void;
  onOpenMenuAt: (x: number, y: number, node: ExplorerNode) => void;
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
  isTabStop,
  onToggle,
  onSelect,
  onOpenMenu,
  onOpenMenuAt,
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
      aria-label={node.name}
      aria-keyshortcuts="Shift+F10 F2 Delete"
      tabIndex={isTabStop ? 0 : -1}
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
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          const { left, top } = event.currentTarget.getBoundingClientRect();
          onOpenMenuAt(left + 24, top + ROW_HEIGHT, node);
        }
      }}
      className={`group absolute top-0 left-0 flex h-7 w-full cursor-default items-center rounded-md pr-2 text-sm ${isSelected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
      style={{ paddingLeft: `${8 + depth * 14}px`, transform: `translateY(${start}px)` }}
      title={`${node.path} ${node.className}`}
    >
      <button
        type="button"
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
        aria-hidden="true"
        tabIndex={-1}
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
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [waitingLong, setWaitingLong] = useState(false);
  useEffect(() => {
    setWaitingLong(false);
    if (!waiting) return;
    const timer = window.setTimeout(() => setWaitingLong(true), LONG_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  // An object each time, so a second click on the same link still scrolls to it.
  const [scrollTarget, setScrollTarget] = useState<{ id: string } | null>(null);
  const {
    expanded,
    setExpanded,
    selectedId,
    setSelectedId,
    search,
    setSearch,
    firstShowing,
    scrollTopRef,
  } = useExplorerView();
  const [menu, setMenu] = useState<{ node: ExplorerNode; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerNode | null>(null);
  const studioId = studioTarget?.selected?.key;
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
    if (!tree?.roots.length || !firstShowing(studioId)) return;
    setExpanded(new Set(tree.roots.map(nodeId)));
  }, [tree, studioId, firstShowing, setExpanded]);

  const selectNode = useCallback(
    (node: ExplorerNode) => setSelectedId(nodeId(node)),
    [setSelectedId],
  );

  const toggleNode = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [setExpanded],
  );

  useEffect(() => {
    // A reply can link to an object before this panel's next sync has it, so the request waits.
    const chain = focusRequest && tree ? chainToPath(tree.roots, focusRequest) : null;
    if (!chain) return;
    consumeFocus();
    setSearch("");
    const ids = chain.map(nodeId);
    setSelectedId(ids[ids.length - 1]);
    setScrollTarget({ id: ids[ids.length - 1] });
    // Keyboard users clicked a link to get here, so focus comes too.
    pendingFocusRef.current = ids[ids.length - 1];
    setExpanded((current) => new Set([...current, ...ids.slice(0, -1)]));
  }, [focusRequest, tree, consumeFocus, setSearch, setSelectedId, setExpanded]);

  // Rows are named by path, so in another place this would silently be a different object. Studio can
  // reuse a key for another place, so the place's ID and name count too, as in the Explorer's provider.
  const selectedStudio = studioTarget?.selected;
  const placeKey = selectedStudio
    ? JSON.stringify([selectedStudio.key, selectedStudio.placeId ?? null, selectedStudio.label])
    : null;
  const selectionPlaceRef = useRef(placeKey);
  useEffect(() => {
    if (selectionPlaceRef.current === placeKey) return;
    selectionPlaceRef.current = placeKey;
    setFocusedId(null);
    setRenamingId(null);
    setMenu(null);
    setDeleteTarget(null);
    pendingFocusRef.current = null;
  }, [placeKey]);

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
    initialOffset: scrollTopRef.current,
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

  const openMenu = useCallback(
    (event: MouseEvent, node: ExplorerNode) => {
      event.preventDefault();
      setSelectedId(nodeId(node));
      setMenu({ node, ...menuPosition(event) });
      posthog.capture("object_menu_opened", analyticsProperties("explorer"));
    },
    [setSelectedId],
  );

  const openMenuAt = useCallback(
    (x: number, y: number, node: ExplorerNode) => {
      setSelectedId(nodeId(node));
      setMenu({ node, ...menuPosition({ clientX: x, clientY: y }) });
      posthog.capture("object_menu_opened", analyticsProperties("explorer"));
    },
    [setSelectedId],
  );

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
      const startedIn = selectionPlaceRef.current;
      try {
        const { name } = await desktop.editExplorerObject(studioId, request);
        posthog.capture("object_edited", analyticsProperties("explorer", { action: edit.action }));
        // The rows are another place's by now, where the same path is a different object.
        if (selectionPlaceRef.current === startedIn) onDone(name);
        // What it's called now, except for a delete, where the old name is all there is.
        setEditNote(
          `${EDIT_DONE[edit.action] ?? "Changed"} ${edit.action === "delete" ? node.name : name}.`,
        );
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

  const focusRowRef = useRef<(id: string) => void>(() => {});
  // Where focus goes once the next read has brought that row in.
  const pendingFocusRef = useRef<string | null>(null);
  // The row focus is on its way to, so an older row still being waited for gives way to it.
  const focusTargetRef = useRef<string | null>(null);
  const focusInTreeRef = useRef(false);
  const lastFocusIndexRef = useRef(0);
  const [editNote, setEditNote] = useState<string | null>(null);
  const handleRenamed = useCallback(
    (node: ExplorerNode, name: string | null) => {
      setRenamingId(null);
      // The field that had focus is gone, so it goes back to the row.
      focusRowRef.current(nodeId(node));
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
        // The row is about to come back under its new name, and focus has to come back with it.
        pendingFocusRef.current = to;
      });
    },
    [editObject, setExpanded, setSelectedId],
  );

  // Stable, because the dialog's focus handling starts over whenever this changes.
  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const handleDelete = (node: ExplorerNode) => {
    setDeleteTarget(null);
    // Its row is going away, so focus goes to the one before it, or after it if it was first.
    const shown = [...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? [])];
    const at = shown.findIndex((row) => row.dataset.id === nodeId(node));
    const nextFocus = (shown[at - 1] ?? shown[at + 1])?.dataset.id;
    void editObject(node, { action: "delete" }, () => {
      setSelectedId((current) =>
        current === nodeId(node) || current?.startsWith(`${nodeId(node)}.`) ? null : current,
      );
      if (nextFocus) pendingFocusRef.current = nextFocus;
    });
  };

  const waitingNotice = waiting
    ? ((waitingLong ? EXPLORER_LONG_WAIT_NOTICES[waiting] : undefined) ??
      EXPLORER_WAIT_NOTICES[waiting])
    : null;
  const placeClosed = !studioId && studioTarget?.missing && studioTarget.status !== "loading";
  const noMatches = !!tree && !!query && rows.length === 0;
  const statusNotice = placeClosed
    ? studioTarget.status === "error"
      ? "Couldn't reach Studio."
      : (studioTarget.twins ?? 0) > 1
        ? `${studioTarget.twins} places named ${placeName(studioTarget.missing?.label ?? "")} are open. Choose one in the Studio picker.`
        : studioTarget.nameMatch
          ? `Is the open ${placeName(studioTarget.nameMatch.label)} this chat's place?`
          : `${placeName(studioTarget.missing?.label ?? "")} isn't open. Reopen it to see its objects.`
    : (waitingNotice ??
      (syncError
        ? "Explorer couldn’t load this place. If it keeps failing, restart Studio."
        : null));
  // Coming back from a notice is news too, and whatever had focus in it has gone.
  const [recovered, setRecovered] = useState(false);
  const hadNotice = useRef(false);
  const checkNowFocused = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (statusNotice) {
      hadNotice.current = true;
      setRecovered(false);
      setEditNote(null);
    } else if (hadNotice.current && tree) {
      hadNotice.current = false;
      setRecovered(true);
      if (checkNowFocused.current) searchRef.current?.focus();
      checkNowFocused.current = false;
    }
  }, [statusNotice, tree]);

  const focusableRows = rows.filter((row) => !row.loading);
  // Has to be a row that's actually rendered, or Tab would skip the tree altogether.
  const renderedRows = virtualizer
    .getVirtualItems()
    .flatMap((item) => (rows[item.index] && !rows[item.index]?.loading ? [rows[item.index]] : []));
  const tabStopId =
    focusedId && renderedRows.some((row) => row && nodeId(row.node) === focusedId)
      ? focusedId
      : renderedRows[0]
        ? nodeId(renderedRows[0].node)
        : null;

  focusRowRef.current = (id: string) => focusRow(id);
  // Coming back to the panel picks up at what was selected, not at the top.
  const resumedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the first rows arrive
  useEffect(() => {
    if (resumedRef.current || rows.length === 0) return;
    resumedRef.current = true;
    const index = selectedId
      ? rows.findIndex((row) => !row.loading && nodeId(row.node) === selectedId)
      : -1;
    if (index < 0) return;
    setFocusedId(selectedId);
    virtualizer.scrollToIndex(index);
  }, [rows]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the rows it's waiting for arrive
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (id && rows.some((row) => !row.loading && nodeId(row.node) === id)) {
      pendingFocusRef.current = null;
      focusRowRef.current(id);
      return;
    }
    // The agent or a closing place can take the focused row away, and focus shouldn't go with it.
    if (!focusInTreeRef.current || document.activeElement !== document.body || id) return;
    const usable = rows.filter((row) => !row.loading);
    const nearest = usable[Math.min(lastFocusIndexRef.current, usable.length - 1)];
    if (nearest) focusRowRef.current(nodeId(nearest.node));
  }, [rows]);
  const focusRow = (id: string) => {
    setFocusedId(id);
    focusTargetRef.current = id;
    const index = rows.findIndex((row) => !row.loading && nodeId(row.node) === id);
    if (index >= 0) virtualizer.scrollToIndex(index);
    // A row scrolled to from far off is only drawn once the list catches up, which can take a few
    // frames. Not forever, though, and not once another row has been asked for.
    let frames = 0;
    const attempt = () => {
      if (focusTargetRef.current !== id) return;
      const element = [
        ...(treeRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]") ?? []),
      ].find((item) => item.dataset.id === id);
      if (element) element.focus();
      else if (++frames < FOCUS_ROW_FRAMES) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  };

  // One Tab stop for the whole tree and arrow keys inside it, as a tree is expected to work.
  const moveThroughTree = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT") return;
    const id = target.closest<HTMLElement>("[role=treeitem]")?.dataset.id;
    const index = focusableRows.findIndex((row) => nodeId(row.node) === id);
    if (!id || index < 0) return;
    const row = focusableRows[index];
    if (!row) return;
    const next = focusableRows[index + 1];
    const previous = focusableRows[index - 1];
    const go = (to: (typeof focusableRows)[number] | undefined) => {
      event.preventDefault();
      if (to) focusRow(nodeId(to.node));
    };
    const canExpand = row.node.hasChildren || row.node.children.length > 0;
    switch (event.key) {
      case "F2":
        if (canEditObject(row.node) && !waiting) {
          event.preventDefault();
          setRenamingId(id);
        }
        break;
      case "Delete":
      case "Backspace":
        if (canEditObject(row.node) && !waiting) {
          event.preventDefault();
          setDeleteTarget(tree?.byId.get(id) ?? row.node);
        }
        break;
      case "ArrowDown":
        go(next);
        break;
      case "ArrowUp":
        go(previous);
        break;
      case "Home":
        go(focusableRows[0]);
        break;
      case "End":
        go(focusableRows[focusableRows.length - 1]);
        break;
      case "ArrowRight":
        // A search shows what matches however things are expanded, so there's nothing to change.
        if (canExpand && !visibleExpanded.has(id) && !query) {
          event.preventDefault();
          toggleNode(id);
        } else if (canExpand) go(next);
        break;
      case "ArrowLeft":
        if (canExpand && visibleExpanded.has(id) && !query) {
          event.preventDefault();
          toggleNode(id);
        } else {
          go(
            focusableRows
              .slice(0, index)
              .reverse()
              .find((item) => item.depth < row.depth),
          );
        }
        break;
    }
  };

  const checkNow = (
    <button
      type="button"
      onFocus={() => {
        checkNowFocused.current = true;
      }}
      onBlur={() => {
        checkNowFocused.current = false;
      }}
      onClick={() => {
        if (!syncing) requestSync();
      }}
      aria-busy={syncing}
      className="shrink-0 underline underline-offset-2 hover:text-foreground aria-busy:opacity-60"
    >
      {syncing ? "Checking…" : "Check now"}
    </button>
  );

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

      {tree || !statusNotice ? (
        <div className="px-3 pb-2 pt-1">
          <div className="flex h-8 items-center gap-2 rounded-md border bg-transparent px-2 text-muted-foreground focus-within:border-ring focus-within:text-foreground">
            <Search aria-hidden="true" size={12} />
            <input
              type="search"
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search instances"
              aria-label="Search Explorer"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      ) : null}

      {/* Always in the page, so a screen reader announces it when the words arrive. */}
      <output className="sr-only">
        {statusNotice ??
          (noMatches
            ? "No matches."
            : (editNote ?? (tree ? (recovered ? "Explorer is back." : null) : "Loading objects.")))}
      </output>
      {statusNotice ? (
        <div
          className={
            !tree
              ? "flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs leading-relaxed text-muted-foreground"
              : syncError
                ? "flex shrink-0 items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                : "flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2 text-xs text-muted-foreground"
          }
        >
          <span aria-hidden="true">{statusNotice}</span>
          {placeClosed ? (
            studioTarget.nameMatch ? (
              <button
                type="button"
                onClick={() => {
                  if (!studioTarget.nameMatch) return;
                  void studioTarget.select(studioTarget.nameMatch).then((worked) => {
                    if (worked) {
                      document.querySelector<HTMLElement>('[aria-label="Message"]')?.focus();
                    }
                  });
                }}
                className="shrink-0 underline underline-offset-2 hover:text-foreground"
              >
                Use it
              </button>
            ) : null
          ) : (
            checkNow
          )}
        </div>
      ) : null}

      {truncated ? (
        <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
          This place is too large to list in full, so some objects are missing here.
        </div>
      ) : null}

      <div
        ref={treeRef}
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
        className={`min-h-0 flex-1 overflow-y-auto py-1 ${statusNotice && !tree ? "hidden" : ""}`}
        role="tree"
        aria-label="Instance hierarchy"
        onKeyDown={moveThroughTree}
        onFocus={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset
            .id;
          if (id) setFocusedId(id);
          focusInTreeRef.current = true;
          lastFocusIndexRef.current = rows.findIndex(
            (row) => !row.loading && nodeId(row.node) === id,
          );
        }}
        onBlur={(event) => {
          // Going somewhere else, as opposed to its row disappearing under it.
          if (event.relatedTarget) {
            focusInTreeRef.current = false;
            return;
          }
          // Nothing to go to happens for a click on nothing in particular too, but a row that's
          // still there afterwards wasn't taken away.
          const left = event.target;
          queueMicrotask(() => {
            if (left.isConnected && !treeRef.current?.contains(document.activeElement)) {
              focusInTreeRef.current = false;
            }
          });
        }}
      >
        {!tree && !statusNotice ? <ExplorerLoading /> : null}
        {noMatches ? (
          <p aria-hidden="true" className="px-4 py-2 text-xs text-muted-foreground">
            No matches.
          </p>
        ) : null}
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
                isTabStop={tabStopId === id}
                onToggle={toggleNode}
                onSelect={selectNode}
                onOpenMenu={openMenu}
                onOpenMenuAt={openMenuAt}
                onRenamed={handleRenamed}
                onDroppedInChat={handleDroppedInChat}
              />
            );
          })}
        </div>
      </div>

      {selected && !waiting ? (
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
      ) : tree && !waiting ? (
        <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
          Select an object to see its details, or drag it into your message.
        </div>
      ) : null}

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
          {canEditObject(menu.node) && !waiting ? (
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
          onCancel={cancelDelete}
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
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const openedFrom = document.activeElement;
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      // Back to the row it came from, unless what happened next took focus elsewhere.
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) (openedFrom as HTMLElement | null)?.focus();
      });
    };
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
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        onKeyDown={(event) => {
          // Stays inside the dialog: everything behind it is out of reach while it's open.
          if (event.key !== "Tab") return;
          const buttons = [...(dialogRef.current?.querySelectorAll("button") ?? [])];
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
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
