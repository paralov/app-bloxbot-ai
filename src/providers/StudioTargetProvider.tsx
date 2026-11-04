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

/**
 * Whether a Studio could be the place a chat remembers by name. Different Place IDs rule that out,
 * and so does only one of them being published: those can't be the same place.
 */
function sameNamedPlace(target: StudioTarget, remembered: StudioTarget): boolean {
  const placeId = (id: string | null | undefined) => (id && id !== "0" ? id : null);
  return (
    target.label.trim().toLowerCase() === remembered.label.trim().toLowerCase() &&
    placeId(target.placeId) === placeId(remembered.placeId)
  );
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
  /** Someone chose to use this chat for work that has nothing to do with Studio. */
  withoutStudio: boolean;
  workWithoutStudio(): void;
  /** What the chat's messages say about Studio, since using one is what ties a chat to a place. */
  reportStudioUse(use: { started: boolean; usedStudio: boolean }): void;
  /** This chat has used a Studio, but which one was never written down. */
  unknownPlace: boolean;
  /** How many open Studios share the missing place's name, when that's why nothing was picked. */
  twins: number;
  /**
   * The one open Studio with the missing place's name. A name isn't proof of the same place, as
   * every new template is a "Baseplate", so this is offered rather than taken.
   */
  nameMatch: StudioTarget | null;
  /** Why a message can't go out yet: without a Studio to work in, the agent would pick one itself. */
  sendBlock: string | null;
  /** Resolves with how many Studios are listed afterwards. */
  discover(): Promise<number>;
  /** Resolves with whether it worked. */
  select(target: StudioTarget): Promise<boolean>;
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

/** For a chat with no Studio, so the agent doesn't go looking for one and change the wrong place. */
export const NO_STUDIO_PROMPT_REFERENCE =
  "This chat isn't working in Roblox Studio. Do not use Roblox Studio tools unless the person asks you to connect one.";

/** Several are open and nobody has said which, which is only a question if Studio comes up at all. */
function createChooseStudioPromptReference(targets: readonly StudioTarget[]): string {
  const names = JSON.stringify(targets.map((target) => placeName(target.label)));
  return `Several Roblox Studio places are open: ${names}. Before using any Roblox Studio tool, ask which one this chat should work in. If the request has nothing to do with Roblox, ignore them.`;
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
  const selectOperationRef = useRef(0);
  const selectedRef = useRef<StudioTarget | null>(null);
  selectedRef.current = selected;
  const chatsWithoutStudioRef = useRef<ReadonlySet<string>>(new Set());
  const [withoutStudio, setWithoutStudio] = useState(false);
  const studioUseRef = useRef<{ session: string; used: boolean } | null>(null);
  const unknownPlaceRef = useRef<string | null>(null);
  // Saved places live in a ref, so forgetting one needs a nudge to show.
  const [, setForgotten] = useState(0);
  const [unknownPlace, setUnknownPlace] = useState(false);
  const verifiedKeyRef = useRef<string | null>(null);
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

  const setChatWithoutStudio = useCallback(
    async (on: boolean) => {
      if (!activeSessionId) return;
      setWithoutStudio(on);
      const chats = new Set(chatsWithoutStudioRef.current);
      if (chats.has(activeSessionId) === on) return;
      if (on) chats.add(activeSessionId);
      else chats.delete(activeSessionId);
      chatsWithoutStudioRef.current = chats;
      await desktop.patchConfig({ chatsWithoutStudio: [...chats] });
    },
    [activeSessionId],
  );

  const applyDiscovery = useCallback(
    async (operation: number) => {
      const result = await desktop.discoverStudioTargets();
      if (operation !== operationRef.current) return;
      targetsRef.current = result.targets;
      setTargets(result.targets);
      if (activeSessionId && chatsWithoutStudioRef.current.has(activeSessionId)) {
        setSelected(null);
        setStatus(result.targets.length === 0 ? "empty" : "ready");
        return;
      }
      const remembered = activeSessionId ? targetsBySessionRef.current[activeSessionId] : undefined;
      const askWhich = activeSessionId !== null && unknownPlaceRef.current === activeSessionId;
      const placeMatches = remembered?.placeId
        ? result.targets.filter((target) => target.placeId === remembered.placeId)
        : [];
      let nextSelected = remembered
        ? (result.targets.find((target) => target.key === remembered.key) ??
          (placeMatches.length === 1 ? placeMatches[0] : undefined) ??
          null)
        : // Not tied to anything yet, so it stays with the Studio it has while that's still open.
          (result.targets.find(
            (target) =>
              !askWhich && target.key === (result.selectedKey ?? selectedRef.current?.key),
          ) ?? null);
      const selectionMode = nextSelected
        ? nextSelected.key === remembered?.key
          ? "session_id_match"
          : "place_id_match"
        : "automatic";
      // Once is enough for a Studio this run of the app has already checked: this runs every few
      // seconds, and repeating it would keep disabling the picker and rewriting the config.
      if (
        nextSelected &&
        result.selectedKey !== nextSelected.key &&
        verifiedKeyRef.current !== nextSelected.key
      ) {
        setSelectingKey(nextSelected.key);
        const selection = await desktop.selectStudioTarget(nextSelected.key);
        if (operation !== operationRef.current) return;
        if (!selection.verified) throw new Error("Target verification failed");
        nextSelected = selection.selected;
        verifiedKeyRef.current = nextSelected.key;
        await rememberTarget(nextSelected);
        setSelectingKey(null);
      }
      // A chat tied to a place stays tied to it: the only other open Studio could be a place the
      // agent was never meant to change, so that needs someone to choose it. A chat that hasn't
      // used Studio can take it, and isn't tied until it does, since it may be about something else.
      if (!nextSelected && !remembered && !askWhich && result.targets.length === 1) {
        const onlyTarget = result.targets[0];
        selectedRef.current = onlyTarget;
        setSelectingKey(onlyTarget.key);
        posthog.capture("studio_target_selected", analyticsProperties("studio_target"));
        const selection = await desktop.selectStudioTarget(onlyTarget.key);
        if (operation !== operationRef.current) return;
        if (!selection.verified) throw new Error("Target verification failed");
        nextSelected = selection.selected;
        verifiedKeyRef.current = nextSelected.key;
        posthog.capture(
          "studio_target_verification_succeeded",
          analyticsProperties("studio_target", {
            outcome: "success",
            selection_mode: selectionMode,
          }),
        );
        setSelectingKey(null);
      }
      // Kept current, since a place can be renamed or published while it's open, and the next reopen
      // has to recognize it from what's written down here.
      if (
        nextSelected &&
        remembered &&
        (nextSelected.key !== remembered.key ||
          nextSelected.label !== remembered.label ||
          nextSelected.placeId !== remembered.placeId)
      ) {
        await rememberTarget(nextSelected);
      }
      if (operation !== operationRef.current) return;
      setSelected(nextSelected);
      setStatus(result.targets.length === 0 ? "empty" : "ready");
      // A selection this replaced was left mid-way, and nothing else will finish it.
      if (!selectingRef.current) setSelectingKey(null);
      // This runs every few seconds, so only a change is worth reporting.
      const discoveryReport = JSON.stringify([
        nextSelected?.key ?? null,
        result.targets.map((target) => [target.key, target.placeId ?? null]),
      ]);
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
      selectOperationRef.current = operation;
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
        if (operation !== operationRef.current) return false;
        verifiedKeyRef.current = result.selected.key;
        await setChatWithoutStudio(false);
        unknownPlaceRef.current = null;
        setUnknownPlace(false);
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
        return true;
      } catch (error) {
        if (operation !== operationRef.current) return false;
        errorSourceRef.current = "select";
        setError("That Studio window is no longer available. Refresh and choose another.");
        posthog.capture(
          "studio_target_verification_failed",
          errorAnalyticsProperties("studio_target", "verification", error, {
            selection_mode: "manual",
          }),
        );
        return false;
      } finally {
        // By the latest selection, not the latest operation: switching chats starts a newer one,
        // and nothing else would ever let go of this.
        if (operation === selectOperationRef.current) {
          selectingRef.current = false;
          setSelectingKey(null);
        }
      }
    },
    [rememberTarget, setChatWithoutStudio],
  );

  const workWithoutStudio = useCallback(() => {
    if (!activeSessionId) return;
    operationRef.current += 1;
    setSelected(null);
    if (targetsBySessionRef.current[activeSessionId]) {
      const { [activeSessionId]: _forgotten, ...rest } = targetsBySessionRef.current;
      targetsBySessionRef.current = rest;
      void desktop.patchConfig({ studioTargetsBySession: rest });
    }
    void setChatWithoutStudio(true);
  }, [activeSessionId, setChatWithoutStudio]);

  const reportStudioUse = useCallback(
    ({ started, usedStudio }: { started: boolean; usedStudio: boolean }) => {
      if (!activeSessionId || !configLoadedRef.current) return;
      const remembered = targetsBySessionRef.current[activeSessionId];
      const seen = studioUseRef.current;
      if (seen?.session !== activeSessionId) {
        // The first look at this chat says what it was already doing, not what it's doing now.
        studioUseRef.current = { session: activeSessionId, used: usedStudio };
        if (!usedStudio && started && remembered) {
          // Older versions saved whichever Studio was open, even for a chat about something else.
          const { [activeSessionId]: _forgotten, ...rest } = targetsBySessionRef.current;
          targetsBySessionRef.current = rest;
          void desktop.patchConfig({ studioTargetsBySession: rest });
          setForgotten((count) => count + 1);
          void discover();
        } else if (usedStudio && !remembered && !selectedRef.current) {
          unknownPlaceRef.current = activeSessionId;
          setUnknownPlace(true);
        } else if (usedStudio && !remembered) {
          // It has used a Studio, and the one open now could be any place at all.
          unknownPlaceRef.current = activeSessionId;
          selectedRef.current = null;
          setSelected(null);
          setUnknownPlace(true);
        }
        return;
      }
      if (!usedStudio || seen.used) return;
      seen.used = true;
      const current = selectedRef.current;
      if (current && !remembered) void rememberTarget(current);
    },
    [activeSessionId, discover, rememberTarget],
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
        chatsWithoutStudioRef.current = new Set(config.chatsWithoutStudio ?? []);
        configLoadedRef.current = true;
      }
      setWithoutStudio(chatsWithoutStudioRef.current.has(activeSessionId));
      setUnknownPlace(unknownPlaceRef.current === activeSessionId);
      // A remembered id can belong to a Studio that has since closed, and discovery will tell.
      const remembered = targetsBySessionRef.current[activeSessionId];
      const restored =
        remembered && targetsRef.current.some((target) => target.key === remembered.key)
          ? remembered
          : null;
      selectedRef.current = restored;
      setSelected(restored);
      await discover();
    };
    void loadAndDiscover();
  }, [activeSessionId, client, discover]);

  const remembered = activeSessionId ? targetsBySessionRef.current[activeSessionId] : undefined;
  const missing = !withoutStudio && !selected && remembered ? remembered : null;
  const sameName = missing ? targets.filter((target) => sameNamedPlace(target, missing)) : [];
  const twins = sameName.length;
  const nameMatch = twins === 1 ? (sameName[0] ?? null) : null;
  // Only when there's a place the agent could get wrong. With no Studio open there's nothing to get
  // wrong, and a chat can carry on with whatever else it's about.
  const sendBlock =
    withoutStudio || targets.length === 0
      ? status === "loading" && !withoutStudio
        ? "Finding Studios."
        : null
      : missing && twins > 1
        ? `${twins} places named ${placeName(missing.label)} are open. Choose one, or work without Studio.`
        : missing && nameMatch
          ? `Is the open ${placeName(missing.label)} this chat's place? Choose it, or work without Studio.`
          : missing
            ? `${placeName(missing.label)} isn't open. Reopen it, choose another, or work without Studio.`
            : unknownPlace && !selected
              ? "Choose which Studio this chat worked in, or work without Studio."
              : null;

  // Quickly while someone is waiting on a Studio to appear, or on this chat's place to reopen. Slowly
  // otherwise, so a Studio closing is noticed without anyone having to open the Explorer.
  useEffect(() => {
    if (!client || status === "loading" || withoutStudio) return;
    const waitingForStudio = status === "empty" || missing !== null;
    const timer = window.setInterval(
      () => {
        if (!selectingRef.current) void discover();
      },
      waitingForStudio ? 2_000 : 10_000,
    );
    return () => window.clearInterval(timer);
  }, [client, discover, missing, status, withoutStudio]);

  const promptReference = selected
    ? createStudioTargetPromptReference(selected)
    : withoutStudio || missing || (status !== "loading" && targets.length === 0)
      ? NO_STUDIO_PROMPT_REFERENCE
      : targets.length > 1
        ? createChooseStudioPromptReference(targets)
        : null;
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
      withoutStudio,
      workWithoutStudio,
      reportStudioUse,
      unknownPlace,
      twins,
      nameMatch,
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
      withoutStudio,
      workWithoutStudio,
      reportStudioUse,
      unknownPlace,
      twins,
      nameMatch,
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
