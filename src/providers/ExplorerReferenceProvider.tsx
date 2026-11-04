import {
  createContext,
  type Dispatch,
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

/** What someone has opened and searched for, which outlives the panel being closed. */
export interface ExplorerView {
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  selectedId: string | null;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  /** Whether this is the first look at a place, when its services open out. */
  firstShowing: (studioId: string | undefined) => boolean;
}

const ExplorerViewContext = createContext<ExplorerView | null>(null);

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);
// Its own context because it changes many times a second while a big place loads, which only the
// Explorer panel needs to hear about.
const ExplorerTreeContext = createContext<ExplorerTreeSync | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const sync = useExplorerTreeSync();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const shownStudioRef = useRef<string | undefined>(undefined);
  const firstShowing = useCallback((studioId: string | undefined) => {
    if (shownStudioRef.current === studioId) return false;
    shownStudioRef.current = studioId;
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
    }),
    [expanded, selectedId, search, firstShowing],
  );
  // Rows are named by path, so in another place this would silently be a different object. Here, as
  // the panel may be closed when the Studio changes.
  const studioId = useStudioTargetOptional()?.selected?.key;
  const viewStudioRef = useRef(studioId);
  useEffect(() => {
    if (viewStudioRef.current === studioId) return;
    viewStudioRef.current = studioId;
    setSelectedId(null);
    setSearch("");
  }, [studioId]);
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
