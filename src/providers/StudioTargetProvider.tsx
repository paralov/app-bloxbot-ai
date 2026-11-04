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
import {
  analyticsProperties,
  detailedAnalyticsProperties,
  errorAnalyticsProperties,
  setStudioAnalyticsContext,
} from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import { useActiveSession } from "@/providers/ActiveSessionProvider";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import type { StudioTarget } from "@/types/studioTarget";

export type StudioTargetStatus = "loading" | "ready" | "empty" | "error";

interface StudioTargetContextValue {
  targets: readonly StudioTarget[];
  selected: StudioTarget | null;
  promptReference: string | null;
  status: StudioTargetStatus;
  selectingKey: string | null;
  error: string | null;
  /** Resolves with how many Studios are listed afterwards. */
  discover(): Promise<number>;
  select(target: StudioTarget): Promise<void>;
}

const StudioTargetContext = createContext<StudioTargetContextValue | null>(null);

function countBucket(count: number): "0" | "1" | "2-4" | "5+" {
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count < 5) return "2-4";
  return "5+";
}

function discoveredPlaceIds(targets: readonly StudioTarget[]): string[] {
  return [...new Set(targets.flatMap((target) => (target.placeId ? [target.placeId] : [])))];
}

export function createStudioTargetPromptReference(target: StudioTarget): string {
  return `Route every Roblox Studio MCP tool call for this request to studio_id ${JSON.stringify(target.key)}. The selected Studio is ${JSON.stringify(target.label)}${target.placeId ? ` with Place ID ${JSON.stringify(target.placeId)}` : ""}. Do not call set_active_studio; routing is stateless. Re-list Studios and stop if this studio_id is no longer connected.`;
}

export function StudioTargetProvider({ children }: { children: ReactNode }) {
  const { client } = useOpenCodeClient();
  const { activeSessionId } = useActiveSession();
  const [targets, setTargets] = useState<readonly StudioTarget[]>([]);
  const [selected, setSelected] = useState<StudioTarget | null>(null);
  const [status, setStatus] = useState<StudioTargetStatus>("loading");
  const [selectingKey, setSelectingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operationRef = useRef(0);
  const targetsRef = useRef<readonly StudioTarget[]>([]);
  const discoveryRef = useRef<Promise<number> | null>(null);
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

  const applyDiscovery = useCallback(
    async (operation: number) => {
      const result = await desktop.discoverStudioTargets();
      if (operation !== operationRef.current) return;
      targetsRef.current = result.targets;
      setTargets(result.targets);
      const remembered = activeSessionId ? targetsBySessionRef.current[activeSessionId] : undefined;
      const placeMatches = remembered?.placeId
        ? result.targets.filter((target) => target.placeId === remembered.placeId)
        : [];
      const labelMatches = remembered
        ? result.targets.filter(
            (target) => target.label.trim().toLowerCase() === remembered.label.trim().toLowerCase(),
          )
        : [];
      let nextSelected = remembered
        ? (result.targets.find((target) => target.key === remembered.key) ??
          (placeMatches.length === 1 ? placeMatches[0] : undefined) ??
          (labelMatches.length === 1 ? labelMatches[0] : undefined) ??
          null)
        : (result.targets.find((target) => target.key === result.selectedKey) ?? null);
      const selectionMode = nextSelected
        ? nextSelected.key === remembered?.key
          ? "session_id_match"
          : remembered?.placeId && nextSelected.placeId === remembered.placeId
            ? "place_id_match"
            : "session_name_match"
        : "automatic";
      if (nextSelected && result.selectedKey !== nextSelected.key) {
        setSelectingKey(nextSelected.key);
        const selection = await desktop.selectStudioTarget(nextSelected.key);
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
        const selection = await desktop.selectStudioTarget(onlyTarget.key);
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
          ...detailedAnalyticsProperties({
            roblox_place_id: nextSelected?.placeId ?? undefined,
            roblox_discovered_place_ids: discoveredPlaceIds(result.targets),
            roblox_studio_count: result.targets.length,
          }),
        }),
      );
    },
    [activeSessionId, rememberTarget],
  );

  const discover = useCallback(async () => {
    if (discoveryRef.current) return discoveryRef.current;
    const discovery = (async () => {
      const operation = ++operationRef.current;
      try {
        await applyDiscovery(operation);
        if (operation === operationRef.current) setError(null);
      } catch (discoveryError) {
        if (operation === operationRef.current) {
          setStatus(targetsRef.current.length > 0 ? "ready" : "error");
          setSelectingKey(null);
          console.error("[studio-target] discovery failed", discoveryError);
          setError("Couldn't reach Roblox Studio. Refresh to try again.");
          posthog.capture(
            "studio_target_discovery_failed",
            errorAnalyticsProperties("studio_target", "discovery", discoveryError),
          );
        }
      }
      return targetsRef.current.length;
    })().finally(() => {
      discoveryRef.current = null;
    });
    discoveryRef.current = discovery;
    return discovery;
  }, [applyDiscovery]);

  const select = useCallback(
    async (target: StudioTarget) => {
      const operation = ++operationRef.current;
      setSelectingKey(target.key);
      setError(null);
      posthog.capture(
        "studio_target_selected",
        analyticsProperties("studio_target", { selection_mode: "manual" }),
      );
      try {
        const result = await desktop.selectStudioTarget(target.key);
        if (!result.verified) throw new Error("Target verification failed");
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
    [rememberTarget],
  );

  // AI traces attach the Studio place the prompt was routed to.
  useEffect(() => {
    setStudioAnalyticsContext(
      selected || targets.length > 0
        ? {
            placeId: selected?.placeId ?? null,
            placeName: selected?.label ?? null,
            discoveredPlaceIds: discoveredPlaceIds(targets),
            discoveredCount: targets.length,
          }
        : null,
    );
  }, [selected, targets]);

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
      // A remembered id can belong to a Studio that has since closed, and discovery will tell.
      const remembered = targetsBySessionRef.current[activeSessionId];
      setSelected(
        remembered && targetsRef.current.some((target) => target.key === remembered.key)
          ? remembered
          : null,
      );
      await discover();
    };
    void loadAndDiscover();
  }, [activeSessionId, client, discover]);

  useEffect(() => {
    if (!client || status !== "empty") return;
    const timer = window.setInterval(() => void discover(), 2_000);
    return () => window.clearInterval(timer);
  }, [client, discover, status]);

  const promptReference = selected ? createStudioTargetPromptReference(selected) : null;
  const value = useMemo(
    () => ({
      targets,
      selected,
      promptReference,
      status,
      selectingKey,
      error,
      discover,
      select,
    }),
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
