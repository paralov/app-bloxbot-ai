import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { type ExplorerNode, indexExplorerObjects } from "@/lib/explorer";

interface ExplorerReferenceContextValue {
  pendingReference: string | null;
  objects: readonly ExplorerNode[];
  referenceObject: (prompt: string) => void;
  consumeReference: () => void;
  publishObjects: (objects: readonly ExplorerNode[]) => void;
  objectIndex: ReadonlyMap<string, ExplorerNode | null>;
  /** The object a click in the chat asked the Explorer to show. */
  focusRequest: string | null;
  focusObject: (path: string) => void;
  consumeFocus: () => void;
}

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const [objects, setObjects] = useState<readonly ExplorerNode[]>([]);
  const referenceObject = useCallback((prompt: string) => setPendingReference(prompt), []);
  const consumeReference = useCallback(() => setPendingReference(null), []);
  const publishObjects = useCallback((next: readonly ExplorerNode[]) => setObjects(next), []);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const consumeFocus = useCallback(() => setFocusRequest(null), []);
  const value = useMemo(
    () => ({
      pendingReference,
      objects,
      referenceObject,
      consumeReference,
      publishObjects,
      objectIndex: indexExplorerObjects(objects),
      focusRequest,
      focusObject: setFocusRequest,
      consumeFocus,
    }),
    [
      pendingReference,
      objects,
      referenceObject,
      consumeReference,
      publishObjects,
      focusRequest,
      consumeFocus,
    ],
  );

  return (
    <ExplorerReferenceContext.Provider value={value}>{children}</ExplorerReferenceContext.Provider>
  );
}

export function useExplorerReference() {
  const value = useContext(ExplorerReferenceContext);
  if (!value) throw new Error("useExplorerReference must be used inside ExplorerReferenceProvider");
  return value;
}
