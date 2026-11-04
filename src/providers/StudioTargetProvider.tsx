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

/** Studio's window label ends with a place ID nobody needs to read. */
export function placeName(label: string): string {
  return label.replace(/\s*\(placeId:[^)]*\)$/, "");
}

interface StudioTargetContextValue {
  targets: readonly StudioTarget[];
  selected: StudioTarget | null;
  promptReference: string | null;
  status: StudioTargetStatus;
  selectingKey: string | null;
  error: string | null;
  /** The place this chat was working in, when it isn't open any more. */
  missing: StudioTarget | null;
  /** Why a message can't go out yet: without a Studio to work in, the agent would pick one itself. */
  sendBlock: string | null;
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
  const discoveryRef = useRef<{ session: string | null; promise: Promise<number> } | null>(null);
  const selectingRef = useRef(false);
  // Only what discovery itself got wrong clears when discovery next works.
  const errorSourceRef = useRef<"discovery" | "select" | null>(null);
  const lastDiscoveryReportRef = useRef<string | null>(null);
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
      // Two places can share a name, so a different Place ID always rules a name match out.
      const labelMatches = remembered
        ? result.targets.filter(
            (target) =>
              target.label.trim().toLowerCase() === remembered.label.trim().toLowerCase() &&
              (!remembered.placeId || !target.placeId || target.placeId === remembered.placeId),
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
      // A chat tied to a place stays tied to it: the only other open Studio could be a place the
      // agent was never meant to change, so that needs someone to choose it.
      if (!nextSelected && !remembered && result.targets.length === 1) {
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
      // A chat that took the Studio already in use is tied to it too, or it would follow to another
      // place if that one closed.
      if (nextSelected && !remembered) await rememberTarget(nextSelected);
      if (operation !== operationRef.current) return;
      setSelected(nextSelected);
      setStatus(result.targets.length === 0 ? "empty" : "ready");
      // A selection this replaced was left mid-way, and nothing else will finish it.
      if (!selectingRef.current) setSelectingKey(null);
      // This runs every few seconds, so only a change is worth reporting.
      const discoveryReport = `${result.targets.length}:${nextSelected?.key ?? ""}`;
      if (discoveryReport === lastDiscoveryReportRef.current) return;
      lastDiscoveryReportRef.current = discoveryReport;
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
    // One that's running for another chat would apply that chat's place to this one.
    if (discoveryRef.current?.session === activeSessionId) return discoveryRef.current.promise;
    const discovery = (async () => {
      const operation = ++operationRef.current;
      try {
        await applyDiscovery(operation);
        if (operation === operationRef.current && errorSourceRef.current === "discovery") {
          errorSourceRef.current = null;
          setError(null);
        }
      } catch (discoveryError) {
        if (operation === operationRef.current) {
          setStatus(targetsRef.current.length > 0 ? "ready" : "error");
          setSelectingKey(null);
          const alreadyReported = errorSourceRef.current === "discovery";
          errorSourceRef.current = "discovery";
          console.error("[studio-target] discovery failed", discoveryError);
          setError("Couldn't reach Roblox Studio. Refresh to try again.");
          if (!alreadyReported)
            posthog.capture(
              "studio_target_discovery_failed",
              errorAnalyticsProperties("studio_target", "discovery", discoveryError),
            );
        }
      }
      return targetsRef.current.length;
    })().finally(() => {
      if (discoveryRef.current?.promise === discovery) discoveryRef.current = null;
    });
    discoveryRef.current = { session: activeSessionId, promise: discovery };
    return discovery;
  }, [activeSessionId, applyDiscovery]);

  const select = useCallback(
    async (target: StudioTarget) => {
      const operation = ++operationRef.current;
      selectingRef.current = true;
      setSelectingKey(target.key);
      errorSourceRef.current = null;
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
        errorSourceRef.current = "select";
        setError("That Studio window is no longer available. Refresh and choose another.");
        posthog.capture(
          "studio_target_verification_failed",
          errorAnalyticsProperties("studio_target", "verification", error, {
            selection_mode: "manual",
          }),
        );
      } finally {
        if (operation === operationRef.current) {
          selectingRef.current = false;
          setSelectingKey(null);
        }
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

  const remembered = activeSessionId ? targetsBySessionRef.current[activeSessionId] : undefined;
  const missing = !selected && remembered ? remembered : null;
  const sendBlock =
    status === "loading"
      ? "Finding Studios."
      : missing
        ? `${placeName(missing.label)} isn't open. Reopen it or choose another.`
        : status === "ready" && !selected
          ? "Choose a Studio first."
          : null;

  // Quickly while someone is waiting on a Studio to appear, or on this chat's place to reopen. Slowly
  // otherwise, so a Studio closing is noticed without anyone having to open the Explorer.
  useEffect(() => {
    if (!client || status === "loading") return;
    const waitingForStudio = status !== "ready" || missing !== null;
    const timer = window.setInterval(
      () => {
        if (!selectingRef.current) void discover();
      },
      waitingForStudio ? 2_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [client, discover, missing, status]);

  const promptReference = selected ? createStudioTargetPromptReference(selected) : null;
  const value = useMemo(
    () => ({
      targets,
      selected,
      promptReference,
      status,
      selectingKey,
      error,
      missing,
      sendBlock,
      discover,
      select,
    }),
    [
      targets,
      selected,
      promptReference,
      status,
      selectingKey,
      error,
      missing,
      sendBlock,
      discover,
      select,
    ],
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
