import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type ExplorerTreeSync, useExplorerTreeSync } from "@/hooks/useExplorerTreeSync";
import { type ExplorerNode, type ExplorerReference, indexExplorerObjects } from "@/lib/explorer";

interface ExplorerReferenceContextValue {
  pendingReference: ExplorerReference | null;
  objects: readonly ExplorerNode[];
  /** Nothing to offer yet, because the first read is running or failed. */
  objectsLoading: boolean;
  objectsFailed: boolean;
  requestSync: ExplorerTreeSync["requestSync"];
  referenceObject: (reference: ExplorerReference) => void;
  consumeReference: () => void;
  objectIndex: ReadonlyMap<string, ExplorerNode | null>;
  /** The object a click in the chat asked the Explorer to show. */
  focusRequest: string | null;
  focusObject: (path: string) => void;
  consumeFocus: () => void;
}

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);
// Its own context because it changes many times a second while a big place loads, which only the
// Explorer panel needs to hear about.
const ExplorerTreeContext = createContext<ExplorerTreeSync | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const sync = useExplorerTreeSync();
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
  const objectsFailed = (syncError !== null || waiting !== null) && objects.length === 0;
  const objectIndex = useMemo(() => indexExplorerObjects(objects), [objects]);
  const value = useMemo(
    () => ({
      pendingReference,
      objects,
      objectsLoading,
      objectsFailed,
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
      <ExplorerReferenceContext.Provider value={value}>
        {children}
      </ExplorerReferenceContext.Provider>
    </ExplorerTreeContext.Provider>
  );
}

export function useExplorerReference() {
  const value = useContext(ExplorerReferenceContext);
  if (!value) throw new Error("useExplorerReference must be used inside ExplorerReferenceProvider");
  return value;
}

export function useExplorerTree() {
  const value = useContext(ExplorerTreeContext);
  if (!value) throw new Error("useExplorerTree must be used inside ExplorerReferenceProvider");
  return value;
}
