import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  select: vi.fn(),
  loadConfig: vi.fn(),
  patchConfig: vi.fn(),
  capture: vi.fn(),
  client: {},
  session: { id: "chat" },
}));

vi.mock("@/lib/desktop", () => ({
  desktop: {
    discoverStudioTargets: mocks.discover,
    selectStudioTarget: mocks.select,
    loadConfig: mocks.loadConfig,
    patchConfig: mocks.patchConfig,
  },
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: mocks.client }),
}));
vi.mock("@/providers/ActiveSessionProvider", () => ({
  useActiveSession: () => ({ activeSessionId: mocks.session.id }),
}));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture, register: vi.fn() },
}));

import { StudioTargetProvider, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Writes down every target the app was told to read, which the Explorer would have read at once. */
function Seen({ keys }: { keys: Array<string | null> }) {
  const studioTarget = useStudioTargetOptional();
  const key = studioTarget?.selected?.key ?? null;
  keys.push(key);
  return (
    <div>
      <div>selected: {key ?? "none"}</div>
      <div>status: {studioTarget?.status}</div>
      <div>missing: {studioTarget?.missing?.label ?? "none"}</div>
      <div>block: {studioTarget?.sendBlock ?? "none"}</div>
    </div>
  );
}

describe("StudioTargetProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.patchConfig.mockResolvedValue(undefined);
  });

  it("doesn't offer a remembered Studio id until discovery has found it", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { key: "old-id", label: "Dungeon", detail: null } },
    });
    let finish: (value: unknown) => void = () => {};
    mocks.discover.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.select.mockResolvedValue({
      selected: { key: "new-id", label: "Dungeon", detail: null },
      verified: true,
    });
    const keys: Array<string | null> = [];

    render(
      <StudioTargetProvider>
        <Seen keys={keys} />
      </StudioTargetProvider>,
    );
    await waitFor(() => expect(mocks.discover).toHaveBeenCalled());
    finish({ targets: [{ key: "new-id", label: "Dungeon", detail: null }], selectedKey: null });

    expect(await screen.findByText("selected: new-id")).toBeInTheDocument();
    expect(keys).not.toContain("old-id");
  });

  it("doesn't move a chat to a different place when its own Studio is gone", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: {
        chat: { key: "old-id", label: "Dungeon", detail: null, placeId: "1" },
      },
    });
    mocks.discover.mockResolvedValue({
      targets: [{ key: "other-id", label: "Lobby", detail: null, placeId: "2" }],
      selectedKey: null,
    });

    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );

    // Once discovery has finished, not just started, since "none" is also how this begins.
    expect(await screen.findByText("status: ready")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.patchConfig).not.toHaveBeenCalled();
  });

  it("doesn't move a chat to a different place that happens to share its name", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: {
        chat: { key: "old-id", label: "Baseplate", detail: null, placeId: "1" },
      },
    });
    mocks.discover.mockResolvedValue({
      targets: [{ key: "other-id", label: "Baseplate", detail: null, placeId: "2" }],
      selectedKey: null,
    });

    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );

    expect(await screen.findByText("status: ready")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("doesn't rejoin an unpublished place from a published one, or the reverse", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: {
        chat: { key: "old-id", label: "Baseplate", detail: null, placeId: "1" },
      },
    });
    mocks.discover.mockResolvedValue({
      targets: [{ key: "other-id", label: "Baseplate", detail: null, placeId: null }],
      selectedKey: null,
    });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("status: ready")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("asks which one when two open places share the chat's place's name", async () => {
    const twin = { label: "Baseplate", detail: null, placeId: null };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { ...twin, key: "old-id" } },
    });
    mocks.discover.mockResolvedValue({
      targets: [
        { ...twin, key: "one" },
        { ...twin, key: "two" },
      ],
      selectedKey: null,
    });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(
      await screen.findByText("block: 2 places named Baseplate are open. Choose one."),
    ).toBeInTheDocument();
  });

  it("ties a chat to the Studio it took, so it won't follow to another place", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
    mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: "s1" });

    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );

    expect(await screen.findByText("selected: s1")).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.patchConfig).toHaveBeenCalledWith({
      studioTargetsBySession: { chat: dungeon },
    });
  });

  it("notices a chat's Studio closing without anything else asking", async () => {
    vi.useFakeTimers();
    try {
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
      mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: "s1" });
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("selected: s1")).toBeInTheDocument();

      mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(10_000));

      expect(screen.getByText("selected: none")).toBeInTheDocument();
      expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the background check while someone is choosing a Studio", async () => {
    vi.useFakeTimers();
    try {
      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      let finishSelect: (value: unknown) => void = () => {};
      mocks.select.mockReturnValue(
        new Promise((resolve) => {
          finishSelect = resolve;
        }),
      );
      let choose: (target: typeof lobby) => void = () => {};
      function Chooser() {
        const studioTarget = useStudioTargetOptional();
        choose = (target) => void studioTarget?.select(target);
        return <div>selecting: {studioTarget?.selectingKey ?? "none"}</div>;
      }
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
          <Chooser />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      act(() => choose(lobby));
      mocks.discover.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(mocks.discover).not.toHaveBeenCalled();

      finishSelect({ selected: lobby, verified: true });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("selecting: none")).toBeInTheDocument();
      expect(screen.getByText("selected: lobby")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failed choice on screen through the background check", async () => {
    vi.useFakeTimers();
    try {
      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockResolvedValue({
        targets: [lobby, { ...lobby, key: "other", label: "Other" }],
        selectedKey: null,
      });
      mocks.select.mockRejectedValue(new Error("gone"));
      let choose: (target: typeof lobby) => void = () => {};
      function Chooser() {
        const studioTarget = useStudioTargetOptional();
        choose = (target) => void studioTarget?.select(target);
        return <div>error: {studioTarget?.error ?? "none"}</div>;
      }
      render(
        <StudioTargetProvider>
          <Chooser />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      act(() => choose(lobby));
      await act(() => vi.advanceTimersByTimeAsync(0));
      await act(() => vi.advanceTimersByTimeAsync(10_000));

      expect(screen.getByText(/That Studio window is no longer available/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says what's holding a message back, and only then", async () => {
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    const other = { key: "other", label: "Other", detail: null, placeId: "3" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
    let finish: (value: unknown) => void = () => {};
    mocks.discover.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { unmount } = render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("block: Finding Studios.")).toBeInTheDocument();

    await act(async () => finish({ targets: [lobby, other], selectedKey: null }));
    expect(await screen.findByText("block: Choose a Studio first.")).toBeInTheDocument();
    unmount();

    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("status: empty")).toBeInTheDocument();
    expect(screen.getByText("block: none")).toBeInTheDocument();
  });

  it("doesn't hand one chat's running check to the next chat", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: dungeon, next: lobby },
    });
    let finishFirst: (value: unknown) => void = () => {};
    mocks.discover.mockReturnValueOnce(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    mocks.discover.mockResolvedValue({ targets: [dungeon, lobby], selectedKey: "lobby" });
    const tree = (
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>
    );
    const { rerender } = render(tree);
    await waitFor(() => expect(mocks.discover).toHaveBeenCalledTimes(1));

    mocks.session.id = "next";
    try {
      rerender(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      expect(await screen.findByText("selected: lobby")).toBeInTheDocument();
      await act(async () => finishFirst({ targets: [dungeon, lobby], selectedKey: "s1" }));
      expect(screen.getByText("selected: lobby")).toBeInTheDocument();
    } finally {
      mocks.session.id = "chat";
    }
  });

  it("keeps looking after a failed check, reporting the failure once", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockRejectedValue(new Error("offline"));
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("status: error")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(6_000));
      expect(
        mocks.capture.mock.calls.filter(([name]) => name === "studio_target_discovery_failed"),
      ).toHaveLength(1);

      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      mocks.select.mockResolvedValue({ selected: lobby, verified: true });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(screen.getByText("selected: lobby")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks a Studio once, not on every background check", async () => {
    vi.useFakeTimers();
    try {
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
      mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: dungeon, verified: true });
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(mocks.select).toHaveBeenCalledOnce();
      mocks.patchConfig.mockClear();

      await act(() => vi.advanceTimersByTimeAsync(35_000));

      expect(mocks.select).toHaveBeenCalledOnce();
      expect(mocks.patchConfig).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps saying a Studio was matched by name after later checks", async () => {
    vi.useFakeTimers();
    try {
      const old = { key: "old-id", label: "Baseplate", detail: null, placeId: null };
      const reopened = { ...old, key: "new-id" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: old } });
      mocks.discover.mockResolvedValue({ targets: [reopened], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: reopened, verified: true });
      function Rejoined() {
        return <div>rejoined: {String(useStudioTargetOptional()?.rejoinedByName)}</div>;
      }
      render(
        <StudioTargetProvider>
          <Rejoined />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("rejoined: true")).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(25_000));
      expect(screen.getByText("rejoined: true")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't offer another Studio when none is open", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { key: "s1", label: "Dungeon", detail: null, placeId: "1" } },
    });
    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(
      await screen.findByText("block: Dungeon isn't open. Reopen it in Studio."),
    ).toBeInTheDocument();
  });

  it("picks a chat's place back up when it opens again", async () => {
    vi.useFakeTimers();
    try {
      const dungeon = { key: "old-id", label: "Dungeon", detail: null, placeId: "1" };
      const reopened = { ...dungeon, key: "new-id" };
      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: reopened, verified: true });

      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();

      mocks.discover.mockResolvedValue({ targets: [lobby, reopened], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(2_000));

      expect(screen.getByText("selected: new-id")).toBeInTheDocument();
      expect(screen.getByText("missing: none")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still selects the only Studio for a chat that hasn't used one yet", async () => {
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
    const target = { key: "only-id", label: "Lobby", detail: null, placeId: "2" };
    mocks.discover.mockResolvedValue({ targets: [target], selectedKey: null });
    mocks.select.mockResolvedValue({ selected: target, verified: true });

    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );

    expect(await screen.findByText("selected: only-id")).toBeInTheDocument();
  });

  it("still selects a remembered Studio that discovery finds under the same id", async () => {
    const target = { key: "same-id", label: "Dungeon", detail: null };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: target } });
    mocks.discover.mockResolvedValue({ targets: [target], selectedKey: "same-id" });

    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );

    expect(await screen.findByText("selected: same-id")).toBeInTheDocument();
  });
});
