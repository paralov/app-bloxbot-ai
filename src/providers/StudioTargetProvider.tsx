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
import { splitModelKey } from "@/lib/splitModelKey";
import { generateStudioTargetPrograms } from "@/lib/studioTargetPrograms";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { usePreferences } from "@/providers/PreferencesProvider";
import type {
  StudioTarget,
  StudioTargetPrograms,
  StudioTargetSelection,
} from "@/types/studioTarget";

export type StudioTargetStatus = "loading" | "ready" | "empty" | "error";

interface StudioTargetContextValue {
  targets: readonly StudioTarget[];
  selected: StudioTarget | null;
  promptReference: string | null;
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
  const { client } = useOpenCodeClient();
  const { selectedModel, selectedAgent } = usePreferences();
  const [targets, setTargets] = useState<readonly StudioTarget[]>([]);
  const [selected, setSelected] = useState<StudioTarget | null>(null);
  const [status, setStatus] = useState<StudioTargetStatus>("loading");
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(0);
  const programsRef = useRef<StudioTargetPrograms | null>(null);
  const generationRef = useRef<Promise<StudioTargetPrograms> | null>(null);

  const generatePrograms = useCallback(async () => {
    if (generationRef.current) return generationRef.current;
    if (!client) throw new Error("The local agent is not ready");
    const model = selectedModel
      ? (() => {
          const [providerID, modelID] = splitModelKey(selectedModel);
          return providerID && modelID ? { providerID, modelID } : undefined;
        })()
      : undefined;
    const generation = generateStudioTargetPrograms(client, model, selectedAgent)
      .then((envelopes) => desktop.installStudioTargetPrograms(envelopes))
      .then(async (programs) => {
        programsRef.current = programs;
        await desktop.patchConfig({ studioTargetPrograms: programs });
        return programs;
      })
      .finally(() => {
        generationRef.current = null;
      });
    generationRef.current = generation;
    return generation;
  }, [client, selectedAgent, selectedModel]);

  const getPrograms = useCallback(async () => {
    if (programsRef.current) return programsRef.current;
    const config = await desktop.loadConfig();
    if (config.studioTargetPrograms) {
      programsRef.current = config.studioTargetPrograms;
      return config.studioTargetPrograms;
    }
    return generatePrograms();
  }, [generatePrograms]);

  const applyDiscovery = useCallback(async (programs: StudioTargetPrograms, operation: number) => {
    const result = await desktop.discoverStudioTargets(programs);
    if (operation !== operationRef.current) return;
    setTargets(result.targets);
    let nextSelected = result.targets.find((target) => target.key === result.selectedKey) ?? null;
    if (!nextSelected && result.targets.length === 1) {
      const onlyTarget = result.targets[0];
      setSelectingKey(onlyTarget.key);
      posthog.capture("studio_target_selected");
      const selection = await desktop.selectStudioTarget(programs, onlyTarget.key);
      if (operation !== operationRef.current) return;
      if (!selection.verified) throw new Error("Target verification failed");
      nextSelected = selection.selected;
      posthog.capture("studio_target_verification_succeeded");
      setSelectingKey(null);
    }
    setSelected(nextSelected);
    setStatus(result.targets.length === 0 ? "empty" : "ready");
    posthog.capture("studio_target_discovery_succeeded", {
      count_bucket: countBucket(result.targets.length),
    });
  }, []);

  const discover = useCallback(async () => {
    const operation = ++operationRef.current;
    setStatus("loading");
    setError(null);
    try {
      const programs = await getPrograms();
      await applyDiscovery(programs, operation);
    } catch {
      if (operation !== operationRef.current) return;
      try {
        programsRef.current = null;
        const regenerated = await generatePrograms();
        await applyDiscovery(regenerated, operation);
      } catch {
        if (operation !== operationRef.current) return;
        setStatus("error");
        setSelectingKey(null);
        setError("Couldn’t check connected Studio windows.");
        posthog.capture("studio_target_discovery_failed");
      }
    }
  }, [applyDiscovery, generatePrograms, getPrograms]);

  const select = useCallback(
    async (target: StudioTarget) => {
      const operation = ++operationRef.current;
      setSelectingKey(target.key);
      setError(null);
      posthog.capture("studio_target_selected");
      const attempt = async (programs: StudioTargetPrograms) => {
        const result = await desktop.selectStudioTarget(programs, target.key);
        if (!result.verified) throw new Error("Target verification failed");
        return result;
      };
      try {
        let result: StudioTargetSelection;
        try {
          result = await attempt(await getPrograms());
        } catch {
          programsRef.current = null;
          result = await attempt(await generatePrograms());
        }
        if (operation !== operationRef.current) return;
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
    },
    [generatePrograms, getPrograms],
  );

  useEffect(() => {
    if (!client) return;
    void discover();
    return () => {
      operationRef.current += 1;
    };
  }, [client, discover]);

  const promptReference = selected
    ? `The app-selected Studio target is "${selected.label}". Treat that label as a hint; verify the active target before place-specific work.`
    : null;
  const value = useMemo(
    () => ({ targets, selected, promptReference, status, selectingKey, error, discover, select }),
    [targets, selected, promptReference, status, selectingKey, error, discover, select],
  );
  return <StudioTargetContext.Provider value={value}>{children}</StudioTargetContext.Provider>;
}

export function useStudioTarget() {
  const value = useContext(StudioTargetContext);
  if (!value) throw new Error("useStudioTarget must be used inside StudioTargetProvider");
  return value;
}

export function useStudioTargetOptional() {
  return useContext(StudioTargetContext);
}
