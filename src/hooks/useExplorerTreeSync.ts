import posthog from "posthog-js/dist/module.full.no-external.js";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  analyticsProperties,
  errorAnalyticsProperties,
  explorerAnalyticsProperties,
} from "@/lib/analytics";
import { desktop } from "@/lib/desktop";
import {
  applyExplorerUpdates,
  type ExplorerNode,
  type ExplorerTree,
  type ExplorerTreeUpdate,
  type ExplorerWait,
  emptyExplorerTree,
} from "@/lib/explorer";
import { useOpenCodeClient } from "@/providers/OpenCodeClientProvider";
import { useStudioTargetOptional } from "@/providers/StudioTargetProvider";

// How often to ask once Studio says when the tree changes, which costs two tiny calls.
const WATCHED_SYNC_MS = 1_500;
const ACTIVE_SYNC_MS = 2_500;
const IDLE_SYNC_MS = 5_000;
const MAX_UNCHANGED_SYNC_MS = 30_000;
// After failures, wait longer each time up to this, so a broken Studio setup
// doesn't retry every few seconds.
const MAX_FAILURE_BACKOFF_MS = 5 * 60_000;
// Gives Studio time to itself when a place needs long reads, however often something changes.
const SLOWEST_READ_PACING = 8;
const UPDATE_BATCH_MS = 100;
const OBJECTS_PUBLISH_MS = 1_000;

export interface ExplorerTreeSync {
  readonly tree: ExplorerTree | null;
  /** Settled copies of the tree's roots, which change less often than the tree does. */
  readonly objects: readonly ExplorerNode[];
  readonly truncated: boolean;
  readonly syncing: boolean;
  readonly syncError: string | null;
  /** Studio can't be read right now because of what it's doing, which isn't an error. */
  readonly waiting: ExplorerWait | null;
  /** Whether the Explorer panel wants the tree kept up to date, and how lively the chat is. */
  readonly setDemand: (demand: { open: boolean; busy: boolean }) => void;
  /** Reads now. `force` also skips asking whether anything changed, after an edit of our own. */
  readonly requestSync: (options?: { force?: boolean }) => void;
}

/** The one thing that reads Studio's tree, shared by the Explorer panel and the message box. */
export function useExplorerTreeSync(): ExplorerTreeSync {
  const { client } = useOpenCodeClient();
  const studioTarget = useStudioTargetOptional();
  const studioId = studioTarget?.selected?.key ?? null;
  const [tree, setTree] = useState<ExplorerTree | null>(null);
  const [objects, setObjects] = useState<readonly ExplorerNode[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<ExplorerWait | null>(null);
  const [demand, setDemandState] = useState({ open: false, busy: false });

  const treeRef = useRef<ExplorerTree | null>(null);
  const studioRef = useRef(studioId);
  studioRef.current = studioId;
  const discoverRef = useRef(studioTarget?.discover);
  discoverRef.current = studioTarget?.discover;
  const queueRef = useRef<ExplorerTreeUpdate[]>([]);
  const batchTimerRef = useRef<number | undefined>(undefined);
  const objectsStaleRef = useRef(false);
  const objectsPublishedAtRef = useRef(0);
  const syncingRef = useRef(false);
  // Which read is the latest, and whose: another Studio's doesn't have to wait for this one.
  const syncTokenRef = useRef(0);
  const syncStudioRef = useRef<string | null>(null);
  const resyncRef = useRef<{ force: boolean } | null>(null);
  const startRef = useRef<((options: { force: boolean }) => void) | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const wantedRef = useRef<{ force: boolean } | null>(null);
  const telemetryRef = useRef({ firstSyncReported: false, hadFailure: false });
  // Consecutive failed syncs, which set the retry backoff.
  const failuresRef = useRef(0);
  // What Studio is doing, since when, and how many reads have found it still doing that.
  const waitRef = useRef<{ reason: ExplorerWait; since: number; reads: number } | null>(null);
  const unchangedRef = useRef(0);
  const watchingRef = useRef(false);
  const slowestReadRef = useRef(0);

  const publishObjects = useCallback(() => {
    objectsStaleRef.current = false;
    objectsPublishedAtRef.current = Date.now();
    setObjects([...(treeRef.current?.roots ?? [])]);
  }, []);

  const applyQueued = useCallback(() => {
    window.clearTimeout(batchTimerRef.current);
    batchTimerRef.current = undefined;
    if (queueRef.current.length === 0) return;
    const first = !treeRef.current;
    const next = applyExplorerUpdates(treeRef.current ?? emptyExplorerTree(), queueRef.current);
    queueRef.current = [];
    treeRef.current = next;
    setTree(next);
    // The message box builds an index from these, so it hears now and then during a long read,
    // and always at the end of one.
    objectsStaleRef.current = true;
    if (first || Date.now() - objectsPublishedAtRef.current >= OBJECTS_PUBLISH_MS) publishObjects();
  }, [publishObjects]);

  useEffect(
    () =>
      desktop.onExplorerTreeUpdate((update) => {
        if (update.studioId !== studioRef.current) return;
        queueRef.current.push(update);
        batchTimerRef.current ??= window.setTimeout(applyQueued, UPDATE_BATCH_MS);
      }),
    [applyQueued],
  );

  // A tree belongs to one place. Switching Studio also retries straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: studioId is what triggers the reset
  useEffect(() => {
    window.clearTimeout(batchTimerRef.current);
    batchTimerRef.current = undefined;
    queueRef.current = [];
    treeRef.current = null;
    setTree(null);
    setObjects([]);
    setTruncated(false);
    setSyncError(null);
    setWaiting(null);
    failuresRef.current = 0;
    waitRef.current = null;
    unchangedRef.current = 0;
    watchingRef.current = false;
  }, [studioId]);

  // Reopening Explorer retries straight away. This lives outside the sync effect, which also re-runs
  // whenever the chat turns busy or idle and must not clear the backoff.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when Explorer opens
  useEffect(() => {
    failuresRef.current = 0;
    if (waitRef.current) waitRef.current.reads = 0;
  }, [demand.open]);

  useEffect(() => {
    if (!client || !studioId) return;
    let cancelled = false;
    let timer: number | undefined;

    function scheduleNext() {
      if (cancelled || !demand.open) return;
      const baseDelay = demand.busy ? ACTIVE_SYNC_MS : IDLE_SYNC_MS;
      const steady = watchingRef.current
        ? WATCHED_SYNC_MS
        : Math.min(baseDelay * 2 ** Math.min(unchangedRef.current, 3), MAX_UNCHANGED_SYNC_MS);
      const paced = slowestReadRef.current * SLOWEST_READ_PACING;
      const delay =
        failuresRef.current > 0
          ? Math.min(IDLE_SYNC_MS * 2 ** failuresRef.current, MAX_FAILURE_BACKOFF_MS)
          : waitRef.current
            ? Math.min(
                Math.max(IDLE_SYNC_MS * 2 ** Math.max(waitRef.current.reads - 1, 0), paced),
                MAX_FAILURE_BACKOFF_MS,
              )
            : Math.max(steady, paced);
      // Replace any pending timer, so scheduling twice never runs two syncs.
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (document.visibilityState === "hidden" || !document.hasFocus()) scheduleNext();
        else void sync({ force: false });
      }, delay);
    }

    async function sync({ force }: { force: boolean }) {
      if (syncingRef.current && syncStudioRef.current === studioId) {
        resyncRef.current = { force: force || resyncRef.current?.force === true };
        return;
      }
      // Starting this replaces a read of another Studio, which the main process stops.
      const token = ++syncTokenRef.current;
      syncStudioRef.current = studioId;
      resyncRef.current = null;
      syncingRef.current = true;
      const movedOn = () => studioRef.current !== studioId;
      setSyncing(true);
      setSyncError(null);
      const syncStartedAt = performance.now();
      const isFirstSync = !telemetryRef.current.firstSyncReported;
      if (isFirstSync && !waitRef.current) {
        posthog.capture("sync_started", analyticsProperties("explorer", { source: "initial" }));
      }

      try {
        const result = await desktop.syncExplorerTree(studioId as string, {
          fresh: !treeRef.current?.roots.length,
          force,
        });
        if (movedOn()) return;
        applyQueued();
        slowestReadRef.current = result.slowestReadMs;
        if (result.waiting) {
          if (waitRef.current?.reason !== result.waiting) {
            waitRef.current = { reason: result.waiting, since: Date.now(), reads: 0 };
            posthog.capture(
              "sync_waiting",
              analyticsProperties("explorer", {
                outcome: "waiting",
                phase: "sync",
                ...explorerAnalyticsProperties({
                  duration_ms: Math.round(performance.now() - syncStartedAt),
                  reason: result.waiting,
                  source: treeRef.current?.roots.length ? "recovery" : "initial",
                }),
              }),
            );
          }
          waitRef.current.reads += 1;
          failuresRef.current = 0;
          setWaiting(result.waiting);
          // Only a fresh list of Studios can say whether this one came back under a new id.
          if (result.waiting === "studio_closed") void discoverRef.current?.();
          return;
        }
        const current = treeRef.current;
        if (!current || current.roots.length === 0) {
          throw new Error("Studio has not returned an instance tree yet");
        }
        if (waitRef.current) {
          posthog.capture(
            "sync_resumed",
            analyticsProperties(
              "explorer",
              explorerAnalyticsProperties({
                duration_ms: Date.now() - waitRef.current.since,
                reason: waitRef.current.reason,
              }),
            ),
          );
          waitRef.current = null;
          setWaiting(null);
        }
        unchangedRef.current = result.changed ? 0 : unchangedRef.current + 1;
        watchingRef.current = result.watching;
        failuresRef.current = 0;
        setTruncated(result.truncated);
        if (objectsStaleRef.current) publishObjects();
        if (isFirstSync || telemetryRef.current.hadFailure) {
          posthog.capture(
            "sync_succeeded",
            analyticsProperties(
              "explorer",
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - syncStartedAt),
                source: telemetryRef.current.hadFailure ? "recovery" : "initial",
                root_count: current.roots.length,
                node_count: current.byId.size,
              }),
            ),
          );
          telemetryRef.current.firstSyncReported = true;
          telemetryRef.current.hadFailure = false;
        }
      } catch (error) {
        // A Studio that was left behind has nothing to say about the next one.
        if (movedOn()) return;
        console.error("[explorer] sync failed", error);
        telemetryRef.current.hadFailure = true;
        failuresRef.current += 1;
        waitRef.current = null;
        setWaiting(null);
        // Report the first failure of a streak, not every retry.
        if (failuresRef.current === 1)
          posthog.capture(
            "sync_failed",
            errorAnalyticsProperties(
              "explorer",
              "sync",
              error,
              explorerAnalyticsProperties({
                duration_ms: Math.round(performance.now() - syncStartedAt),
                reason: treeRef.current ? "recovery_failed" : "initial_failed",
              }),
            ),
          );
        setSyncError(error instanceof Error ? error.message : String(error));
      } finally {
        // Everything from here belongs to the latest read.
        if (token === syncTokenRef.current) {
          syncingRef.current = false;
          setSyncing(false);
          // A re-sync requested while this one ran waits for the backoff if
          // this one failed.
          const resync = resyncRef.current;
          resyncRef.current = null;
          if (resync && failuresRef.current === 0) {
            queueMicrotask(() => startRef.current?.(resync));
          } else {
            scheduleRef.current();
          }
        }
      }
    }

    startRef.current = (options) => void sync(options);
    scheduleRef.current = scheduleNext;
    const wanted = wantedRef.current;
    wantedRef.current = null;
    // This effect also re-runs when the chat turns busy or idle; during a failure streak or while
    // Studio is occupied, wait for the backoff instead of retrying straight away.
    if (wanted) void sync(wanted);
    else if (demand.open) {
      if (failuresRef.current > 0 || (waitRef.current?.reads ?? 0) > 0) scheduleNext();
      else void sync({ force: false });
    }
    const resume = () => {
      // While failing, wait for the backoff timer rather than retrying every time the window
      // regains focus. Waiting is different: coming back from Studio is when its state has changed.
      if (!demand.open || failuresRef.current > 0) return;
      if (document.visibilityState === "visible" && document.hasFocus()) {
        if (timer !== undefined) window.clearTimeout(timer);
        void sync({ force: false });
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      cancelled = true;
      startRef.current = null;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [applyQueued, client, demand.busy, demand.open, publishObjects, studioId]);

  const requestSync = useCallback((options?: { force?: boolean }) => {
    const request = { force: options?.force === true };
    // The message box asks as it mounts, before this hook's own effect has started.
    if (startRef.current) startRef.current(request);
    else wantedRef.current = request;
  }, []);

  const setDemand = useCallback((next: { open: boolean; busy: boolean }) => {
    setDemandState((current) =>
      current.open === next.open && current.busy === next.busy ? current : next,
    );
  }, []);

  return { tree, objects, truncated, syncing, syncError, waiting, setDemand, requestSync };
}
