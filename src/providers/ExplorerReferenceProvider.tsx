import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { ExplorerNode } from "@/lib/explorer";

interface ExplorerReferenceContextValue {
  pendingReference: string | null;
  objects: readonly ExplorerNode[];
  referenceObject: (prompt: string) => void;
  consumeReference: () => void;
  publishObjects: (objects: readonly ExplorerNode[]) => void;
}

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const [objects, setObjects] = useState<readonly ExplorerNode[]>([]);
  const referenceObject = useCallback((prompt: string) => setPendingReference(prompt), []);
  const consumeReference = useCallback(() => setPendingReference(null), []);
  const publishObjects = useCallback((next: readonly ExplorerNode[]) => setObjects(next), []);
  const value = useMemo(
    () => ({ pendingReference, objects, referenceObject, consumeReference, publishObjects }),
    [pendingReference, objects, referenceObject, consumeReference, publishObjects],
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
