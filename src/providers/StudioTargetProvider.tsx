import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { desktop } from "@/lib/desktop";
import type { StudioTarget } from "@/types/studioTarget";

export type StudioTargetStatus = "loading" | "ready" | "empty" | "error";

interface StudioTargetContextValue {
  targets: readonly StudioTarget[];
  selected: StudioTarget | null;
  status: StudioTargetStatus;
  selectingKey: string | null;
  error: string | null;
  discover(): Promise<void>;
  select(target: StudioTarget): Promise<void>;
}

const StudioTargetContext = createContext<StudioTargetContextValue | null>(null);

function countBucket(count: number): "0" | "1" | "2-4" | "5+" {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count < 5) return "2-4";
  return "5+";
}

export function StudioTargetProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<readonly StudioTarget[]>([]);
  const [selected, setSelected] = useState<StudioTarget | null>(null);
  const [status, setStatus] = useState<StudioTargetStatus>("loading");
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(0);

  const discover = useCallback(async () => {
    const operation = ++operationRef.current;
    setStatus("loading");
    setError(null);
    try {
      const result = await desktop.discoverStudioTargets();
      if (operation !== operationRef.current) return;
      setTargets(result.targets);
      let nextSelected = result.targets.find((target) => target.key === result.selectedKey) ?? null;
      if (!nextSelected && result.targets.length === 1) {
        const onlyTarget = result.targets[0];
        setSelectingKey(onlyTarget.key);
        posthog.capture("studio_target_selected");
        try {
          const selection = await desktop.selectStudioTarget(onlyTarget.key);
          if (operation !== operationRef.current) return;
          if (!selection.verified) throw new Error("Target verification failed");
          nextSelected = selection.selected;
          posthog.capture("studio_target_verification_succeeded");
        } catch {
          if (operation !== operationRef.current) return;
          setError("The only Studio window could not be verified. Refresh to try again.");
          posthog.capture("studio_target_verification_failed");
        } finally {
          if (operation === operationRef.current) setSelectingKey(null);
        }
      }
      setSelected(nextSelected);
      setStatus(result.targets.length === 0 ? "empty" : "ready");
      posthog.capture("studio_target_discovery_succeeded", {
        count_bucket: countBucket(result.targets.length),
      });
    } catch {
      if (operation !== operationRef.current) return;
      setStatus("error");
      setError("Couldn’t check connected Studio windows.");
      posthog.capture("studio_target_discovery_failed");
    }
  }, []);

  const select = useCallback(async (target: StudioTarget) => {
    const operation = ++operationRef.current;
    setSelectingKey(target.key);
    setError(null);
    posthog.capture("studio_target_selected");
    try {
      const result = await desktop.selectStudioTarget(target.key);
      if (operation !== operationRef.current) return;
      if (!result.verified) throw new Error("Target verification failed");
      setSelected(result.selected);
      setTargets((current) =>
        current.some((item) => item.key === result.selected.key)
          ? current
          : [...current, result.selected],
      );
      setStatus("ready");
      posthog.capture("studio_target_verification_succeeded");
    } catch {
      if (operation !== operationRef.current) return;
      setError("That Studio window is no longer available. Refresh and choose another.");
      posthog.capture("studio_target_verification_failed");
    } finally {
      if (operation === operationRef.current) setSelectingKey(null);
    }
  }, []);

  useEffect(() => {
    void discover();
    return () => {
      operationRef.current += 1;
    };
  }, [discover]);

  const value = useMemo(
    () => ({ targets, selected, status, selectingKey, error, discover, select }),
    [targets, selected, status, selectingKey, error, discover, select],
  );
  return <StudioTargetContext.Provider value={value}>{children}</StudioTargetContext.Provider>;
}

export function useStudioTarget() {
  const value = useContext(StudioTargetContext);
  if (!value) throw new Error("useStudioTarget must be used inside StudioTargetProvider");
  return value;
}
