import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(update: unknown) => void>(),
  sync: vi.fn(),
  capture: vi.fn(),
  discover: vi.fn(),
  studio: { selected: { key: "a" } } as {
    selected: { key: string } | null;
    discover?: (showLoading?: boolean) => Promise<void>;
  },
  client: {},
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture },
}));
vi.mock("@/lib/desktop", () => ({
  desktop: {
    syncExplorerTree: mocks.sync,
    onExplorerTreeUpdate: (listener: (update: unknown) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
  },
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: mocks.client }),
}));
vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => mocks.studio,
}));

import { useExplorerTreeSync } from "@/hooks/useExplorerTreeSync";

const node = (name: string) => ({
  name,
  className: "Folder",
  path: `game.${name}`,
  hasChildren: false,
  children: [],
});
const answer = (changed: boolean) => ({
  changed,
  watching: true,
  complete: true,
  truncated: false,
  slowestReadMs: 0,
});
const send = (studioId: string, name: string) => {
  for (const listener of mocks.listeners) {
    listener({ studioId, parentId: null, children: [node(name)] });
  }
};
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

describe("useExplorerTreeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.studio = { selected: { key: "a" } };
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("tells the message box about what a read found, even if the chat changed state during it", async () => {
    const first = deferred<ReturnType<typeof answer>>();
    mocks.sync.mockReturnValueOnce(first.promise);
    mocks.sync.mockResolvedValue(answer(false));
    const { result } = renderHook(() => useExplorerTreeSync(), { wrapper });
    await settle();
    act(() => result.current.setDemand({ open: true, busy: true }));
    await settle();
    expect(mocks.sync).toHaveBeenCalledOnce();

    // The chat turning idle restarts the effect while the read is still going.
    act(() => result.current.setDemand({ open: true, busy: false }));
    await settle();
    await act(async () => {
      send("a", "Found");
      first.resolve(answer(true));
    });
    await settle();

    expect(result.current.objects.map((object) => object.name)).toEqual(["Found"]);

    // Something new, seen by a read whose answer is thrown away, still arrives.
    send("a", "Newer");
    await settle();
    act(() => result.current.requestSync());
    await settle();
    expect(result.current.objects.map((object) => object.name)).toEqual(["Newer"]);
  });

  it("doesn't make a new Studio wait for a read of the old one, or pay for its failure", async () => {
    const old = deferred<ReturnType<typeof answer>>();
    mocks.sync.mockReturnValueOnce(old.promise);
    mocks.sync.mockResolvedValue(answer(true));
    const { result, rerender } = renderHook(() => useExplorerTreeSync(), { wrapper });
    act(() => result.current.setDemand({ open: true, busy: false }));
    await settle();
    expect(mocks.sync).toHaveBeenLastCalledWith("a", expect.anything());

    mocks.studio = { selected: { key: "b" } };
    mocks.sync.mockImplementationOnce(async () => {
      send("b", "InB");
      return answer(true);
    });
    rerender();
    await settle();
    expect(mocks.sync).toHaveBeenLastCalledWith("b", expect.anything());
    expect(result.current.objects.map((object) => object.name)).toEqual(["InB"]);

    await act(async () => old.reject(new Error("That Studio closed")));
    await settle();
    expect(result.current.syncError).toBeNull();
    expect(result.current.syncing).toBe(false);
  });

  it("asks for everything again when what it has is empty", async () => {
    mocks.sync.mockImplementationOnce(async () => {
      // An update for something it doesn't have yet leaves a tree with nothing in it.
      for (const listener of mocks.listeners) {
        listener({ studioId: "a", parentId: "game.Gone", children: [node("Kid")] });
      }
      return answer(false);
    });
    mocks.sync.mockResolvedValue(answer(true));
    const { result } = renderHook(() => useExplorerTreeSync(), { wrapper });
    act(() => result.current.requestSync());
    await settle();
    expect(result.current.syncError).toMatch(/has not returned/);

    act(() => result.current.requestSync());
    await settle();
    expect(mocks.sync).toHaveBeenLastCalledWith("a", { fresh: true, force: false });
  });

  describe("while Studio's state gets in the way", () => {
    const waiting = (reason: string) => ({ ...answer(false), complete: false, waiting: reason });
    const captured = (event: string) =>
      mocks.capture.mock.calls
        .filter(([name]) => name === event)
        .map(([, properties]) => properties);
    const started = () => {
      const hook = renderHook(() => useExplorerTreeSync(), { wrapper });
      act(() => hook.result.current.setDemand({ open: true, busy: false }));
      return hook;
    };

    beforeEach(() => {
      mocks.sync.mockReset();
      mocks.discover.mockReset();
      mocks.discover.mockResolvedValue(undefined);
      mocks.studio = { selected: { key: "a" }, discover: mocks.discover };
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports waiting rather than a failure, once per reason, and when it ends", async () => {
      mocks.sync.mockResolvedValueOnce(waiting("mode_changed"));
      mocks.sync.mockResolvedValueOnce(waiting("mode_changed"));
      mocks.sync.mockImplementationOnce(async () => {
        send("a", "Found");
        return answer(true);
      });
      const { result } = started();
      await settle();
      expect(result.current.waiting).toBe("mode_changed");
      expect(result.current.syncError).toBeNull();

      act(() => result.current.requestSync());
      await settle();
      expect(captured("sync_waiting")).toHaveLength(1);
      expect(captured("sync_waiting")[0]).toMatchObject({
        feature: "explorer",
        outcome: "waiting",
        phase: "sync",
        reason: "mode_changed",
        source: "initial",
      });

      act(() => result.current.requestSync());
      await settle();
      expect(result.current.waiting).toBeNull();
      expect(captured("sync_failed")).toHaveLength(0);
      expect(captured("sync_resumed")).toEqual([
        expect.objectContaining({ reason: "mode_changed", duration_ms: expect.any(Number) }),
      ]);
      // A place that was simply still loading isn't a recovery from anything.
      expect(captured("sync_succeeded")[0]).toMatchObject({ source: "initial" });
    });

    it("reports a new reason when Studio moves on to something else", async () => {
      mocks.sync.mockResolvedValueOnce(waiting("no_place"));
      mocks.sync.mockResolvedValueOnce(waiting("mode_changed"));
      const { result } = started();
      await settle();
      act(() => result.current.requestSync());
      await settle();
      expect(captured("sync_waiting").map(({ reason }) => reason)).toEqual([
        "no_place",
        "mode_changed",
      ]);
    });

    it("keeps real failures as failures, and ends the wait they interrupt", async () => {
      mocks.sync.mockResolvedValueOnce(waiting("mode_changed"));
      mocks.sync.mockRejectedValueOnce(new Error("Studio MCP call failed"));
      const { result } = started();
      await settle();
      act(() => result.current.requestSync());
      await settle();

      expect(result.current.waiting).toBeNull();
      expect(result.current.syncError).toMatch(/MCP call failed/);
      expect(captured("sync_failed")).toHaveLength(1);
    });

    it("looks for what replaced a closed Studio, without showing a loading screen", async () => {
      mocks.sync.mockResolvedValue(waiting("studio_closed"));
      started();
      await settle();
      expect(mocks.discover).toHaveBeenCalledOnce();
    });

    it("leaves the Studio list alone for the other waits", async () => {
      mocks.sync.mockResolvedValue(waiting("no_place"));
      started();
      await settle();
      expect(mocks.discover).not.toHaveBeenCalled();
    });

    it("backs off while waiting, but not so far that opening a place goes unnoticed", async () => {
      vi.useFakeTimers();
      mocks.sync.mockResolvedValue(waiting("no_place"));
      started();
      const advance = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      await advance(0);
      expect(mocks.sync).toHaveBeenCalledTimes(1);
      await advance(5_000);
      expect(mocks.sync).toHaveBeenCalledTimes(2);
      await advance(5_000);
      expect(mocks.sync).toHaveBeenCalledTimes(2);
      await advance(5_000);
      expect(mocks.sync).toHaveBeenCalledTimes(3);
      await advance(10_000);
      expect(mocks.sync).toHaveBeenCalledTimes(4);
      await advance(10 * 60_000);
      // Then every 10 seconds, because someone is usually waiting on the thing they just did.
      expect(mocks.sync).toHaveBeenCalledTimes(64);
    });

    it("gives slow answers room, like any other read", async () => {
      vi.useFakeTimers();
      mocks.sync.mockResolvedValue({ ...waiting("mode_changed"), slowestReadMs: 2_000 });
      started();
      const advance = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      await advance(0);
      await advance(15_000);
      expect(mocks.sync).toHaveBeenCalledTimes(1);
      await advance(1_000);
      expect(mocks.sync).toHaveBeenCalledTimes(2);
    });

    it("tries again on coming back from Studio, but not on the chat changing state", async () => {
      mocks.sync.mockResolvedValue(waiting("no_place"));
      const { result } = started();
      await settle();
      expect(mocks.sync).toHaveBeenCalledTimes(1);

      act(() => result.current.setDemand({ open: true, busy: true }));
      await settle();
      expect(mocks.sync).toHaveBeenCalledTimes(1);

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await settle();
      expect(mocks.sync).toHaveBeenCalledTimes(2);
    });

    it("tries again straight away when Explorer is reopened", async () => {
      mocks.sync.mockResolvedValue(waiting("no_place"));
      const { result } = started();
      await settle();
      act(() => result.current.setDemand({ open: false, busy: false }));
      await settle();
      act(() => result.current.setDemand({ open: true, busy: false }));
      await settle();
      expect(mocks.sync).toHaveBeenCalledTimes(2);
    });

    it("counts one start for a first read that has to wait", async () => {
      mocks.sync.mockResolvedValue(waiting("no_place"));
      const { result } = started();
      await settle();
      act(() => result.current.requestSync());
      await settle();
      expect(captured("sync_started")).toHaveLength(1);
    });

    it("forgets the wait when the Studio changes", async () => {
      mocks.sync.mockResolvedValueOnce(waiting("studio_closed"));
      const { result, rerender } = started();
      await settle();
      expect(result.current.waiting).toBe("studio_closed");

      mocks.studio = { selected: { key: "b" }, discover: mocks.discover };
      mocks.sync.mockImplementationOnce(async () => {
        send("b", "InB");
        return answer(true);
      });
      rerender();
      await settle();
      expect(result.current.waiting).toBeNull();
      // A different Studio answering says nothing about whether the closed one came back.
      expect(captured("sync_resumed")).toHaveLength(0);
    });
  });
});
