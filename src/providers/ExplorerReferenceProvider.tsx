import {
  createContext,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ExplorerTreeSync, useExplorerTreeSync } from "@/hooks/useExplorerTreeSync";
import {
  type ExplorerNode,
  type ExplorerReference,
  type ExplorerWait,
  indexExplorerObjects,
} from "@/lib/explorer";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";
import type { StudioTarget } from "@/types/studioTarget";

interface ExplorerReferenceContextValue {
  pendingReference: ExplorerReference | null;
  objects: readonly ExplorerNode[];
  /** Nothing to offer yet, because the first read is running or failed. */
  objectsLoading: boolean;
  objectsFailed: boolean;
  /** Why objects can't be read yet, when that's only Studio's state and clears up on its own. */
  objectsWaiting: ExplorerWait | null;
  requestSync: ExplorerTreeSync["requestSync"];
  referenceObject: (reference: ExplorerReference) => void;
  consumeReference: () => void;
  objectIndex: ReadonlyMap<string, ExplorerNode | null>;
  /** The object a click in the chat asked the Explorer to show. */
  focusRequest: string | null;
  focusObject: (path: string) => void;
  consumeFocus: () => void;
}

const NOTHING_EXPANDED: Set<string> = new Set();

/**
 * Which place a Studio has open, for keeping the Explorer's state apart. A Place ID survives a rename,
 * and Studio can hand the same key to another place, so the key only counts for an unpublished place,
 * along with its name, which is all there is to tell two of those apart by.
 */
export function explorerPlaceKey(target: StudioTarget | null | undefined): string | undefined {
  if (!target) return undefined;
  return target.placeId && target.placeId !== "0"
    ? JSON.stringify(["place", target.placeId])
    : JSON.stringify(["studio", target.key, target.label]);
}

/** What someone has opened and searched for, which outlives the panel being closed. */
export interface ExplorerView {
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  /** Whether this is the first look at a place, when its services open out. */
  firstShowing: (placeKey: string | undefined) => boolean;
  scrollTopRef: MutableRefObject<number>;
}

const ExplorerViewContext = createContext<ExplorerView | null>(null);

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);
// Its own context because it changes many times a second while a big place loads, which only the
// Explorer panel needs to hear about.
const ExplorerTreeContext = createContext<ExplorerTreeSync | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const sync = useExplorerTreeSync();
  // Per place, so going back to one finds it as it was left.
  const placeKey = explorerPlaceKey(useStudioTargetOptional()?.selected);
  const [expandedByPlace, setExpandedByPlace] = useState<
    ReadonlyMap<string | undefined, Set<string>>
  >(() => new Map());
  const expanded = expandedByPlace.get(placeKey) ?? NOTHING_EXPANDED;
  const setExpanded = useCallback<Dispatch<SetStateAction<Set<string>>>>(
    (action) =>
      setExpandedByPlace((all) => {
        const current = all.get(placeKey) ?? NOTHING_EXPANDED;
        return new Map(all).set(placeKey, typeof action === "function" ? action(current) : action);
      }),
    [placeKey],
  );
  const scrollTopRef = useRef(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const shownPlacesRef = useRef(new Set<string | undefined>());
  const firstShowing = useCallback((place: string | undefined) => {
    if (shownPlacesRef.current.has(place)) return false;
    shownPlacesRef.current.add(place);
    return true;
  }, []);
  const view = useMemo(
    () => ({
      expanded,
      setExpanded,
      selectedId,
      setSelectedId,
      search,
      setSearch,
      firstShowing,
      scrollTopRef,
    }),
    [expanded, setExpanded, selectedId, search, firstShowing],
  );
  // Rows are named by path, so in another place this would silently be a different object. Here, as
  // the panel may be closed when the Studio changes.
  const viewPlaceRef = useRef(placeKey);
  useEffect(() => {
    // A chat with no Studio passing through isn't a different place.
    if (!placeKey || viewPlaceRef.current === placeKey) return;
    viewPlaceRef.current = placeKey;
    setSelectedId(null);
    setSearch("");
    scrollTopRef.current = 0;
  }, [placeKey]);
  const { objects, syncing, syncError, waiting, requestSync } = sync;
  const [pendingReference, setPendingReference] = useState<ExplorerReference | null>(null);
  const referenceObject = useCallback(
    (reference: ExplorerReference) => setPendingReference(reference),
    [],
  );
  const consumeReference = useCallback(() => setPendingReference(null), []);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const consumeFocus = useCallback(() => setFocusRequest(null), []);
  const objectsLoading = syncing && objects.length === 0;
  const objectsFailed = syncError !== null && objects.length === 0;
  const objectsWaiting = objects.length === 0 ? waiting : null;
  const objectIndex = useMemo(() => indexExplorerObjects(objects), [objects]);
  const value = useMemo(
    () => ({
      pendingReference,
      objects,
      objectsLoading,
      objectsFailed,
      objectsWaiting,
      requestSync,
      referenceObject,
      consumeReference,
      objectIndex,
      focusRequest,
      focusObject: setFocusRequest,
      consumeFocus,
    }),
    [
      pendingReference,
      objects,
      objectsLoading,
      objectsFailed,
      objectsWaiting,
      requestSync,
      referenceObject,
      consumeReference,
      objectIndex,
      focusRequest,
      consumeFocus,
    ],
  );

  return (
    <ExplorerTreeContext.Provider value={sync}>
      <ExplorerViewContext.Provider value={view}>
        <ExplorerReferenceContext.Provider value={value}>
          {children}
        </ExplorerReferenceContext.Provider>
      </ExplorerViewContext.Provider>
    </ExplorerTreeContext.Provider>
  );
}

export function useExplorerReference() {
  const value = useContext(ExplorerReferenceContext);
  if (!value) throw new Error("useExplorerReference must be used inside ExplorerReferenceProvider");
  return value;
}

export function useExplorerView() {
  const value = useContext(ExplorerViewContext);
  if (!value) throw new Error("useExplorerView must be used inside ExplorerReferenceProvider");
  return value;
}

export function useExplorerTree() {
  const value = useContext(ExplorerTreeContext);
  if (!value) throw new Error("useExplorerTree must be used inside ExplorerReferenceProvider");
  return value;
}
