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
import { analyticsProperties, errorAnalyticsProperties } from "@/lib/analytics";
import { BUILTIN_STUDIO_TARGET_PROGRAMS } from "@/lib/builtinStudioPrograms";
import { desktop } from "@/lib/desktop";
import { splitModelKey } from "@/lib/splitModelKey";
import { generateStudioTargetPrograms } from "@/lib/studioTargetPrograms";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
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
  const { activeSessionId } = useActiveSession();
  const { selectedModel, selectedAgent } = usePreferences();
  const [targets, setTargets] = useState<readonly StudioTarget[]>([]);
  const [selected, setSelected] = useState<StudioTarget | null>(null);
  const [status, setStatus] = useState<StudioTargetStatus>("loading");
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(0);
  const programsRef = useRef<StudioTargetPrograms | null>(null);
  const builtinInstallRef = useRef<Promise<StudioTargetPrograms> | null>(null);
  const discoveryRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef<Promise<StudioTargetPrograms> | null>(null);
  const targetsBySessionRef = useRef<Record<string, StudioTarget>>({});
  const configLoadedRef = useRef(false);

  const rememberTarget = useCallback(
    async (target: StudioTarget) => {
      if (!activeSessionId) return;
      const next = { ...targetsBySessionRef.current, [activeSessionId]: target };
      targetsBySessionRef.current = next;
      await desktop.patchConfig({ studioTargetsBySession: next });
    },
    [activeSessionId],
  );

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
    if (!builtinInstallRef.current) {
      builtinInstallRef.current = desktop
        .installStudioTargetPrograms(BUILTIN_STUDIO_TARGET_PROGRAMS)
        .finally(() => {
          builtinInstallRef.current = null;
        });
    }
    const programs = await builtinInstallRef.current;
    if (!programsRef.current) {
      programsRef.current = programs;
    }
    return programsRef.current;
  }, []);

  const applyDiscovery = useCallback(
    async (programs: StudioTargetPrograms, operation: number) => {
      const result = await desktop.discoverStudioTargets(programs);
      if (operation !== operationRef.current) return;
      setTargets(result.targets);
      const remembered = activeSessionId ? targetsBySessionRef.current[activeSessionId] : undefined;
      let nextSelected = remembered
        ? (result.targets.find((target) => target.key === remembered.key) ??
          result.targets.find(
            (target) => target.label.trim().toLowerCase() === remembered.label.trim().toLowerCase(),
          ) ??
          null)
        : (result.targets.find((target) => target.key === result.selectedKey) ?? null);
      const selectionMode = nextSelected
        ? nextSelected.key === remembered?.key
          ? "session_id_match"
          : "session_name_match"
        : "automatic";
      if (nextSelected && result.selectedKey !== nextSelected.key) {
        setSelectingKey(nextSelected.key);
        const selection = await desktop.selectStudioTarget(programs, nextSelected.key);
        if (operation !== operationRef.current) return;
        if (!selection.verified) throw new Error("Target verification failed");
        nextSelected = selection.selected;
        await rememberTarget(nextSelected);
        setSelectingKey(null);
      }
      if (!nextSelected && result.targets.length === 1) {
        const onlyTarget = result.targets[0];
        setSelectingKey(onlyTarget.key);
        posthog.capture("studio_target_selected", analyticsProperties("studio_target"));
        const selection = await desktop.selectStudioTarget(programs, onlyTarget.key);
        if (operation !== operationRef.current) return;
        if (!selection.verified) throw new Error("Target verification failed");
        nextSelected = selection.selected;
        await rememberTarget(nextSelected);
        posthog.capture(
          "studio_target_verification_succeeded",
          analyticsProperties("studio_target", {
            outcome: "success",
            selection_mode: selectionMode,
          }),
        );
        setSelectingKey(null);
      }
      setSelected(nextSelected);
      setStatus(result.targets.length === 0 ? "empty" : "ready");
      posthog.capture(
        "studio_target_discovery_succeeded",
        analyticsProperties("studio_target", {
          outcome: "success",
          count_bucket: countBucket(result.targets.length),
          selected: nextSelected !== null,
        }),
      );
    },
    [activeSessionId, rememberTarget],
  );

  const discover = useCallback(
    async (showLoading = true) => {
      if (discoveryRef.current) return discoveryRef.current;
      const discovery = (async () => {
        const operation = ++operationRef.current;
        if (showLoading) setStatus("loading");
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
          } catch (repairError) {
            if (operation !== operationRef.current) return;
            setStatus("error");
            setSelectingKey(null);
            console.error("[studio-target] discovery repair failed", repairError);
            setError("Studio integration setup failed. Refresh to try again.");
            posthog.capture(
              "studio_target_discovery_failed",
              errorAnalyticsProperties("studio_target", "discovery_repair", repairError, {
                used_model_fallback: true,
              }),
            );
          }
        }
      })().finally(() => {
        discoveryRef.current = null;
      });
      discoveryRef.current = discovery;
      return discovery;
    },
    [applyDiscovery, generatePrograms, getPrograms],
  );

  const select = useCallback(
    async (target: StudioTarget) => {
      const operation = ++operationRef.current;
      setSelectingKey(target.key);
      setError(null);
      posthog.capture(
        "studio_target_selected",
        analyticsProperties("studio_target", { selection_mode: "manual" }),
      );
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
        await rememberTarget(result.selected);
        setTargets((current) =>
          current.some((item) => item.key === result.selected.key)
            ? current
            : [...current, result.selected],
        );
        setStatus("ready");
        posthog.capture(
          "studio_target_verification_succeeded",
          analyticsProperties("studio_target", { outcome: "success", selection_mode: "manual" }),
        );
      } catch (error) {
        if (operation !== operationRef.current) return;
        setError("That Studio window is no longer available. Refresh and choose another.");
        posthog.capture(
          "studio_target_verification_failed",
          errorAnalyticsProperties("studio_target", "verification", error, {
            selection_mode: "manual",
          }),
        );
      } finally {
        if (operation === operationRef.current) setSelectingKey(null);
      }
    },
    [generatePrograms, getPrograms, rememberTarget],
  );

  useEffect(() => {
    if (!client || !activeSessionId) {
      setSelected(null);
      return;
    }
    const loadAndDiscover = async () => {
      if (!configLoadedRef.current) {
        const config = await desktop.loadConfig();
        targetsBySessionRef.current = config.studioTargetsBySession ?? {};
        configLoadedRef.current = true;
      }
      setSelected(targetsBySessionRef.current[activeSessionId] ?? null);
      await discover(false);
    };
    void loadAndDiscover();
  }, [activeSessionId, client, discover]);

  useEffect(() => {
    if (!client || status !== "empty") return;
    const timer = window.setInterval(() => void discover(false), 2_000);
    return () => window.clearInterval(timer);
  }, [client, discover, status]);

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
