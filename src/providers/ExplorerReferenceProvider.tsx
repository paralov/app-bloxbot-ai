import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

interface ExplorerReferenceContextValue {
  pendingReference: string | null;
  referenceObject: (prompt: string) => void;
  consumeReference: () => void;
}

const ExplorerReferenceContext = createContext<ExplorerReferenceContextValue | null>(null);

export function ExplorerReferenceProvider({ children }: { children: ReactNode }) {
  const [pendingReference, setPendingReference] = useState<string | null>(null);
  const referenceObject = useCallback((prompt: string) => setPendingReference(prompt), []);
  const consumeReference = useCallback(() => setPendingReference(null), []);
  const value = useMemo(
    () => ({ pendingReference, referenceObject, consumeReference }),
    [pendingReference, referenceObject, consumeReference],
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
