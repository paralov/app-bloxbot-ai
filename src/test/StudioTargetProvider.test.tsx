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

import {
  NO_STUDIO_PROMPT_REFERENCE,
  StudioTargetProvider,
  useStudioTargetOptional,
} from "@/providers/StudioTargetProvider";

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
      studioTargetsBySession: {
        chat: { key: "old-id", label: "Dungeon", detail: null, placeId: "1" },
      },
    });
    let finish: (value: unknown) => void = () => {};
    mocks.discover.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.select.mockResolvedValue({
      selected: { key: "new-id", label: "Dungeon", detail: null, placeId: "1" },
      verified: true,
    });
    const keys: Array<string | null> = [];

    render(
      <StudioTargetProvider>
        <Seen keys={keys} />
      </StudioTargetProvider>,
    );
    await waitFor(() => expect(mocks.discover).toHaveBeenCalled());
    finish({
      targets: [{ key: "new-id", label: "Dungeon", detail: null, placeId: "1" }],
      selectedKey: null,
    });

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
      await screen.findByText(
        "block: 2 places named Baseplate are open. Choose one, or work without Studio.",
      ),
    ).toBeInTheDocument();
  });

  it("doesn't tie a chat to a Studio just for being open, only once the agent has used it", async () => {
    vi.useFakeTimers();
    try {
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: dungeon, verified: true });
      let report: (use: { started: boolean; usedStudio: boolean }) => void = () => {};
      function Tie() {
        report = useStudioTargetOptional()?.reportStudioUse ?? report;
        return null;
      }
      const tree = (
        <StudioTargetProvider>
          <Seen keys={[]} />
          <Tie />
        </StudioTargetProvider>
      );
      render(tree);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("selected: s1")).toBeInTheDocument();
      expect(mocks.patchConfig).not.toHaveBeenCalled();
      act(() => report({ started: true, usedStudio: false }));

      // Closing it costs nothing yet: this chat may be about something else entirely.
      mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getByText("missing: none")).toBeInTheDocument();
      expect(screen.getByText("block: none")).toBeInTheDocument();

      mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(screen.getByText("selected: s1")).toBeInTheDocument();

      act(() => report({ started: true, usedStudio: true }));
      expect(mocks.patchConfig).toHaveBeenCalledWith({
        studioTargetsBySession: { chat: dungeon },
      });

      // Now it's tied, so another place doesn't take over when this one closes.
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(screen.getByText("selected: none")).toBeInTheDocument();
      expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays with the Studio it has when a second one opens, if it hasn't used either", async () => {
    vi.useFakeTimers();
    try {
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: dungeon, verified: true });
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));

      mocks.discover.mockResolvedValue({ targets: [dungeon, lobby], selectedKey: null });
      await act(() => vi.advanceTimersByTimeAsync(10_000));

      expect(screen.getByText("selected: s1")).toBeInTheDocument();
      expect(screen.getByText("block: none")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a place an older version saved for a chat that never used Studio", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("missing: Dungeon")).toBeInTheDocument();

    await act(async () => context?.reportStudioUse({ started: true, usedStudio: false }));

    expect(await screen.findByText("missing: none")).toBeInTheDocument();
    expect(mocks.patchConfig).toHaveBeenCalledWith({ studioTargetsBySession: {} });
  });

  it("keeps a place picked by hand even if no tool has used it yet", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: dungeon },
      chatsWithChosenPlace: ["chat"],
    });
    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("missing: Dungeon")).toBeInTheDocument();
    await act(async () => context?.reportStudioUse({ started: true, usedStudio: false }));
    expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();
  });

  it("ties a chat to the Studio its message went to, when that use happened out of sight", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: {},
      routedTargetsBySession: { chat: dungeon },
    });
    mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
    mocks.select.mockResolvedValue({ selected: dungeon, verified: true });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("selected: s1")).toBeInTheDocument();
    await act(async () => context?.reportStudioUse({ started: true, usedStudio: true }));

    expect(screen.getByText("block: none")).toBeInTheDocument();
    expect(mocks.patchConfig).toHaveBeenCalledWith({ studioTargetsBySession: { chat: dungeon } });
  });

  it("says a chat is about Studio by that chat's own choice, not another's", async () => {
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: {},
      chatsWithChosenPlace: ["chat"],
    });
    mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
    mocks.select.mockResolvedValue({ selected: lobby, verified: true });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    const tree = () => (
      <StudioTargetProvider>
        <Spy />
      </StudioTargetProvider>
    );
    const { rerender } = render(tree());
    await waitFor(() => expect(context?.studioChosen).toBe(true));

    mocks.session.id = "next";
    try {
      rerender(tree());
      await waitFor(() => expect(context?.studioChosen).toBe(false));
    } finally {
      mocks.session.id = "chat";
    }
  });

  it("finishes finding Studios after a chat's history abandons the first check", async () => {
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
    let finish: (value: unknown) => void = () => {};
    mocks.discover.mockReturnValueOnce(Promise.resolve({ targets: [lobby], selectedKey: null }));
    mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
    mocks.select.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    await waitFor(() => expect(mocks.select).toHaveBeenCalled());

    await act(async () => context?.reportStudioUse({ started: true, usedStudio: true }));
    await act(async () => finish({ selected: lobby, verified: true }));

    expect(await screen.findByText("status: ready")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(context?.unknownPlace).toBe(true);
  });

  it("names a place closed, rather than saying the chat isn't about Studio", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { key: "s1", label: "Dungeon", detail: null, placeId: "1" } },
      chatsWithChosenPlace: ["chat"],
    });
    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("status: empty")).toBeInTheDocument();
    expect(context?.promptReference).toContain("isn't open");
  });

  it("doesn't follow an id Studio reused for a different place", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: dungeon },
      chatsWithChosenPlace: ["chat"],
    });
    mocks.discover.mockResolvedValue({
      targets: [{ key: "s1", label: "Lobby", detail: null, placeId: "2" }],
      selectedKey: null,
    });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("missing: Dungeon")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
  });

  it("doesn't follow an id Studio reused for a different unpublished place", async () => {
    const baseplate = { key: "s1", label: "Baseplate", detail: null, placeId: null };
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: baseplate },
      chatsWithChosenPlace: ["chat"],
    });
    mocks.discover.mockResolvedValue({
      targets: [{ ...baseplate, label: "Racetrack" }],
      selectedKey: null,
    });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("missing: Baseplate")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
  });

  it("gives a forked chat its parent's place", async () => {
    const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: dungeon } });
    mocks.discover.mockResolvedValue({ targets: [dungeon], selectedKey: null });
    mocks.select.mockResolvedValue({ selected: dungeon, verified: true });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("selected: s1")).toBeInTheDocument();

    act(() => context?.copyPlaceToChat("chat", "fork"));

    expect(mocks.patchConfig).toHaveBeenCalledWith({
      studioTargetsBySession: { chat: dungeon, fork: dungeon },
    });
  });

  it("doesn't let one stuck check keep every chat from sending", async () => {
    vi.useFakeTimers();
    try {
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockReturnValue(new Promise(() => {}));
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
        </StudioTargetProvider>,
      );
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("block: Finding Studios.")).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(screen.getByText("block: none")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks which Studio when a chat used one and it isn't written down", async () => {
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
    mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
    mocks.select.mockResolvedValue({ selected: lobby, verified: true });
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Spy />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("selected: lobby")).toBeInTheDocument();

    await act(async () => context?.reportStudioUse({ started: true, usedStudio: true }));

    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(
      screen.getByText("block: Choose which Studio this chat worked in, or work without Studio."),
    ).toBeInTheDocument();
    expect(mocks.patchConfig).not.toHaveBeenCalled();
  });

  describe("working without Studio", () => {
    const lobby = { key: "lobby", label: "Lobby", detail: null, placeId: "2" };
    let context: ReturnType<typeof useStudioTargetOptional> = null;
    function Spy() {
      context = useStudioTargetOptional();
      return null;
    }
    const renderIt = () =>
      render(
        <StudioTargetProvider>
          <Seen keys={[]} />
          <Spy />
        </StudioTargetProvider>,
      );

    it("frees a chat stuck on a closed place, with another Studio open, for good", async () => {
      mocks.loadConfig.mockResolvedValue({
        studioTargetsBySession: { chat: { ...lobby, key: "gone", label: "Dungeon", placeId: "1" } },
      });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      renderIt();
      expect(await screen.findByText("missing: Dungeon")).toBeInTheDocument();
      expect(
        screen.getByText(
          "block: Dungeon isn't open. Reopen it, choose another, or work without Studio.",
        ),
      ).toBeInTheDocument();

      await act(async () => context?.workWithoutStudio());

      expect(screen.getByText("missing: none")).toBeInTheDocument();
      expect(screen.getByText("block: none")).toBeInTheDocument();
      expect(screen.getByText("selected: none")).toBeInTheDocument();
      expect(context?.promptReference).toBe(NO_STUDIO_PROMPT_REFERENCE);
      expect(mocks.patchConfig).toHaveBeenCalledWith({ studioTargetsBySession: {} });
      expect(mocks.patchConfig).toHaveBeenCalledWith({ chatsWithoutStudio: ["chat"] });
    });

    it("stays that way next time, even with only one Studio open", async () => {
      mocks.loadConfig.mockResolvedValue({
        studioTargetsBySession: {},
        chatsWithoutStudio: ["chat"],
      });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      renderIt();
      await waitFor(() => expect(context?.status).toBe("ready"));

      expect(context?.withoutStudio).toBe(true);
      expect(screen.getByText("selected: none")).toBeInTheDocument();
      expect(mocks.select).not.toHaveBeenCalled();
    });

    it("ends when someone chooses a Studio", async () => {
      mocks.loadConfig.mockResolvedValue({
        studioTargetsBySession: {},
        chatsWithoutStudio: ["chat"],
      });
      mocks.discover.mockResolvedValue({ targets: [lobby], selectedKey: null });
      mocks.select.mockResolvedValue({ selected: lobby, verified: true });
      renderIt();
      await waitFor(() => expect(context?.status).toBe("ready"));

      await act(async () => context?.select(lobby));

      expect(context?.withoutStudio).toBe(false);
      expect(screen.getByText("selected: lobby")).toBeInTheDocument();
      expect(mocks.patchConfig).toHaveBeenCalledWith({ chatsWithoutStudio: [] });
    });

    it("lets go of a selection that switching chats replaced", async () => {
      const dungeon = { key: "s1", label: "Dungeon", detail: null, placeId: "1" };
      mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: {} });
      mocks.discover.mockResolvedValue({ targets: [lobby, dungeon], selectedKey: null });
      let finish: (value: unknown) => void = () => {};
      mocks.select.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const { rerender } = renderIt();
      await waitFor(() => expect(context?.status).toBe("ready"));
      act(() => void context?.select(lobby));
      expect(context?.selectingKey).toBe("lobby");

      mocks.session.id = "next";
      try {
        rerender(
          <StudioTargetProvider>
            <Seen keys={[]} />
            <Spy />
          </StudioTargetProvider>,
        );
        await act(async () => finish({ selected: lobby, verified: true }));
        await waitFor(() => expect(context?.selectingKey).toBeNull());
      } finally {
        mocks.session.id = "chat";
      }
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
    // Several open is only a question if Studio comes up, so the agent asks rather than the box.
    expect(await screen.findByText("status: ready")).toBeInTheDocument();
    expect(screen.getByText("block: none")).toBeInTheDocument();
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
      await act(() => vi.advanceTimersByTimeAsync(10_000));
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

  it("offers a same-named place instead of taking it, and blocks until it's chosen", async () => {
    const old = { key: "old-id", label: "Baseplate", detail: null, placeId: null };
    const open = { ...old, key: "new-id" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: old } });
    mocks.discover.mockResolvedValue({ targets: [open], selectedKey: null });
    let chooseMatch: () => void = () => {};
    function Match() {
      const studioTarget = useStudioTargetOptional();
      chooseMatch = () => {
        if (studioTarget?.nameMatch) void studioTarget.select(studioTarget.nameMatch);
      };
      return <div>match: {studioTarget?.nameMatch?.key ?? "none"}</div>;
    }
    mocks.select.mockResolvedValue({ selected: open, verified: true });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
        <Match />
      </StudioTargetProvider>,
    );

    expect(await screen.findByText("match: new-id")).toBeInTheDocument();
    expect(screen.getByText("selected: none")).toBeInTheDocument();
    expect(
      screen.getByText(
        "block: Is the open Baseplate this chat's place? Choose it, or work without Studio.",
      ),
    ).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();

    await act(async () => chooseMatch());
    expect(await screen.findByText("selected: new-id")).toBeInTheDocument();
    expect(screen.getByText("block: none")).toBeInTheDocument();
  });

  it("keeps what it knows about a place current, so a reopen is recognized", async () => {
    const before = { key: "s1", label: "Baseplate", detail: null, placeId: null };
    const published = { ...before, label: "Dungeon", placeId: "1" };
    mocks.loadConfig.mockResolvedValue({ studioTargetsBySession: { chat: before } });
    mocks.discover.mockResolvedValue({ targets: [published], selectedKey: "s1" });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    await waitFor(() =>
      expect(mocks.patchConfig).toHaveBeenCalledWith({
        studioTargetsBySession: { chat: published },
      }),
    );
  });

  it("doesn't hold a message back when Studio can't be reached", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { key: "s1", label: "Dungeon", detail: null, placeId: "1" } },
    });
    mocks.discover.mockRejectedValue(new Error("offline"));
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("status: error")).toBeInTheDocument();
    expect(screen.getByText("block: none")).toBeInTheDocument();
  });

  it("doesn't hold a message back when no Studio is open, as there's no place to get wrong", async () => {
    mocks.loadConfig.mockResolvedValue({
      studioTargetsBySession: { chat: { key: "s1", label: "Dungeon", detail: null, placeId: "1" } },
    });
    mocks.discover.mockResolvedValue({ targets: [], selectedKey: null });
    render(
      <StudioTargetProvider>
        <Seen keys={[]} />
      </StudioTargetProvider>,
    );
    expect(await screen.findByText("status: empty")).toBeInTheDocument();
    expect(screen.getByText("missing: Dungeon")).toBeInTheDocument();
    expect(screen.getByText("block: none")).toBeInTheDocument();
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
