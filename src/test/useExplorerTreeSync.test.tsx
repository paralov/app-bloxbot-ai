import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listeners: new Set<(update: unknown) => void>(),
  sync: vi.fn(),
  studio: { selected: { key: "a" } as { key: string } | null },
  client: {},
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({ default: { capture: vi.fn() } }));
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
});
