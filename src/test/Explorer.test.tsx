import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  treeListeners: new Set<(update: unknown) => void>(),
  scrollToIndex: vi.fn(),
  getDetails: vi.fn(),
  editObject: vi.fn(),
  notifyError: vi.fn(),
  capture: vi.fn(),
  // Stable, as the real providers' values are: a new one each render restarts Explorer's sync.
  client: {},
  studioTarget: { selected: { key: "studio-1" } },
  reference: {
    referenceObject: vi.fn(),
    focusObject: vi.fn(),
    focusRequest: null as string | null,
    consumeFocus: () => {},
  },
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture },
}));
vi.mock("@/lib/desktop", () => ({
  desktop: {
    onExplorerTreeUpdate: (listener: (update: unknown) => void) => {
      mocks.treeListeners.add(listener);
      return () => mocks.treeListeners.delete(listener);
    },
    // Sends the whole tree as one update, sorted as the main process sorts it.
    syncExplorerTree: async (studioId: string) => {
      const { sortExplorerNodes } = await import("@/lib/explorer");
      const snapshot = await mocks.getSnapshot(studioId);
      if (snapshot.waiting) {
        return {
          changed: false,
          watching: false,
          complete: false,
          truncated: false,
          slowestReadMs: 0,
          waiting: snapshot.waiting,
        };
      }
      for (const listener of mocks.treeListeners) {
        listener({
          studioId,
          parentId: null,
          placeName: snapshot.placeName,
          children: sortExplorerNodes(snapshot.roots),
        });
      }
      return {
        changed: true,
        watching: false,
        complete: true,
        truncated: snapshot.truncated === true,
        slowestReadMs: 0,
      };
    },
    getExplorerNodeDetails: mocks.getDetails,
    editExplorerObject: mocks.editObject,
  },
}));
vi.mock("@/lib/notifications", () => ({
  notify: { error: mocks.notifyError, success: vi.fn() },
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: mocks.client }),
}));
vi.mock("@/providers/StudioTargetProvider", () => ({
  placeName: (label: string) => label.replace(/\s*\(placeId:[^)]*\)$/, ""),
  useStudioTargetOptional: () => mocks.studioTarget,
}));
// The real provider runs the sync. Only what Explorer asks of the rest of the app is replaced.
vi.mock("@/providers/ExplorerReferenceProvider", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/providers/ExplorerReferenceProvider")>();
  return {
    ...real,
    useExplorerReference: () => ({ ...real.useExplorerReference(), ...mocks.reference }),
  };
});
// Renders every row, because jsdom has no sizes to measure.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 28 })),
    getTotalSize: () => count * 28,
    scrollToIndex: mocks.scrollToIndex,
  }),
}));

import Explorer from "@/components/Explorer";
import { indexExplorerObjects, OBJECT_DRAG_TYPE } from "@/lib/explorer";
import { ExplorerReferenceProvider } from "@/providers/ExplorerReferenceProvider";

const tree = {
  placeName: "Obby",
  capturedAt: "2026-11-02T12:00:00Z",
  roots: [
    {
      name: "Workspace",
      className: "Workspace",
      path: "game.Workspace",
      hasChildren: false,
      properties: [],
      attributes: [],
      children: [],
    },
  ],
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("Explorer", () => {
  const onToggle = () => {};
  const start = () =>
    render(
      <ExplorerReferenceProvider>
        <Explorer collapsed={false} sessionBusy={false} onToggle={onToggle} />
      </ExplorerReferenceProvider>,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  });

  afterEach(() => {
    mocks.reference.focusRequest = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a failed first load on its own", async () => {
    mocks.getSnapshot.mockRejectedValueOnce(new Error("Studio is busy"));
    mocks.getSnapshot.mockResolvedValue(tree);

    start();
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent(/If it keeps failing, restart Studio/);

    await advance(10_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Explorer is back.");
  });

  it("treats an empty first tree as not ready yet", async () => {
    mocks.getSnapshot.mockResolvedValueOnce({ ...tree, roots: [] });
    mocks.getSnapshot.mockResolvedValue(tree);

    start();
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent(/If it keeps failing, restart Studio/);

    await advance(10_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("keeps the tree on screen when a later sync fails, then recovers", async () => {
    mocks.getSnapshot.mockResolvedValueOnce(tree);

    start();
    await advance(0);
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    mocks.getSnapshot.mockRejectedValueOnce(new Error("Studio went away"));
    await advance(5_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/If it keeps failing, restart Studio/);

    mocks.getSnapshot.mockResolvedValue(tree);
    await advance(10_000);
    expect(screen.getByRole("status")).toHaveTextContent("Explorer is back.");
  });

  it("says calmly what Studio is doing instead of a failure or a skeleton", async () => {
    mocks.getSnapshot.mockResolvedValueOnce({ waiting: "no_place" });
    mocks.getSnapshot.mockResolvedValue(tree);

    const { container } = start();
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent("No place open. Open one in Studio.");
    expect(container.querySelector(".animate-pulse")).toBeNull();

    await advance(5_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Explorer is back.");
  });

  it("keeps the tree on screen through a playtest starting or stopping", async () => {
    mocks.getSnapshot.mockResolvedValueOnce(tree);

    start();
    await advance(0);
    mocks.getSnapshot.mockResolvedValueOnce({ waiting: "mode_changed" });
    await advance(5_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Playtest starting or stopping");

    mocks.getSnapshot.mockResolvedValue(tree);
    await advance(5_000);
    expect(screen.getByRole("status")).toHaveTextContent("Explorer is back.");
  });

  it("keeps Check now in place through a retry, and hides what can't be used without a tree", async () => {
    mocks.getSnapshot.mockRejectedValue(new Error("Studio is busy"));

    const { container } = start();
    await advance(0);
    const checkNow = screen.getByRole("button", { name: "Check now" });
    expect(screen.queryByRole("searchbox", { name: "Search Explorer" })).toBeNull();
    expect(screen.queryByText(/Select an object/)).toBeNull();
    expect(container.querySelector(".animate-pulse")).toBeNull();

    fireEvent.click(checkNow);
    expect(checkNow).toBeInTheDocument();
    await advance(0);
    expect(screen.getByRole("button", { name: "Check now" })).toBe(checkNow);
  });

  it("stops promising a moment once a wait has gone on, and can check on request", async () => {
    mocks.getSnapshot.mockResolvedValueOnce(tree);
    mocks.getSnapshot.mockResolvedValue({ waiting: "mode_changed" });

    start();
    await advance(0);
    await advance(5_000);
    expect(screen.getByRole("status")).toHaveTextContent("Back in a moment");

    await advance(30_000);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Can't read Studio during this playtest. Stop it to see objects.",
    );

    mocks.getSnapshot.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await advance(0);
    expect(mocks.getSnapshot).toHaveBeenCalledOnce();
  });

  it("says when this chat's place is closed, with nothing to retry", async () => {
    mocks.studioTarget.selected = null as never;
    Object.assign(mocks.studioTarget, {
      status: "ready",
      missing: { key: "gone", label: "Dungeon (placeId: 1)" },
    });
    try {
      start();
      await advance(0);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Dungeon isn't open. Reopen it to see its objects.",
      );
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    } finally {
      mocks.studioTarget.selected = { key: "studio-1" };
      Object.assign(mocks.studioTarget, { status: undefined, missing: undefined });
    }
  });

  it("says when it's back, and moves focus off a Check now that has gone", async () => {
    mocks.getSnapshot.mockRejectedValueOnce(new Error("Studio is busy"));
    mocks.getSnapshot.mockResolvedValue(tree);
    start();
    await advance(0);
    const checkNow = screen.getByRole("button", { name: "Check now" });
    checkNow.focus();
    fireEvent.click(checkNow);
    await advance(0);

    expect(screen.getByRole("status")).toHaveTextContent("Explorer is back.");
    expect(screen.getByRole("searchbox", { name: "Search Explorer" })).toHaveFocus();
  });

  it("says it couldn't reach Studio rather than calling a chat's place closed", async () => {
    mocks.studioTarget.selected = null as never;
    Object.assign(mocks.studioTarget, {
      status: "error",
      missing: { key: "gone", label: "Dungeon (placeId: 1)" },
    });
    try {
      start();
      await advance(0);
      expect(screen.getByRole("status")).toHaveTextContent("Couldn't reach Studio.");
    } finally {
      mocks.studioTarget.selected = { key: "studio-1" };
      Object.assign(mocks.studioTarget, { status: undefined, missing: undefined });
    }
  });

  it("moves through the tree with the arrow keys, with one Tab stop", async () => {
    const lighting = {
      ...tree.roots[0],
      name: "Lighting",
      className: "Lighting",
      path: "game.Lighting",
    };
    mocks.getSnapshot.mockResolvedValue({ ...tree, roots: [lighting, ...tree.roots] });
    start();
    await advance(0);
    const rows = screen.getAllByRole("treeitem");
    expect(rows.filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(rows[0]?.tabIndex).toBe(0);

    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown" });
    await advance(50);
    expect(document.activeElement).toBe(screen.getAllByRole("treeitem")[1]);
  });

  it("opens the actions menu from the keyboard, with focus on its first item", async () => {
    mocks.getSnapshot.mockResolvedValue(tree);
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [], tags: [] });
    start();
    await advance(0);
    const row = screen.getByRole("treeitem", { name: "Workspace" });

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    await advance(0);

    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(items[1] as HTMLElement, { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("doesn't carry a selection over to another place, where it'd be a different object", async () => {
    mocks.getSnapshot.mockResolvedValue(tree);
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [], tags: [] });
    const { rerender } = start();
    await advance(0);
    fireEvent.click(screen.getByText("Workspace"));
    await advance(0);
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Workspace");

    mocks.studioTarget.selected = { key: "studio-2" };
    try {
      rerender(
        <ExplorerReferenceProvider>
          <Explorer collapsed={false} sessionBusy={false} onToggle={onToggle} />
        </ExplorerReferenceProvider>,
      );
      await advance(0);
      expect(screen.queryByRole("treeitem", { selected: true })).toBeNull();
    } finally {
      mocks.studioTarget.selected = { key: "studio-1" };
    }
  });

  it("says when a search finds nothing", async () => {
    mocks.getSnapshot.mockResolvedValue(tree);
    start();
    await advance(0);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Explorer" }), {
      target: { value: "nothing like this" },
    });
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent("No matches.");
  });

  it("announces that objects are loading", async () => {
    mocks.getSnapshot.mockReturnValueOnce(new Promise(() => {}));
    start();
    await advance(0);
    expect(screen.getByRole("status")).toHaveTextContent("Loading objects.");
  });

  it("doesn't offer edits while the tree on screen can't be trusted", async () => {
    mocks.getSnapshot.mockResolvedValueOnce(tree);
    mocks.getSnapshot.mockResolvedValue({ waiting: "studio_closed" });
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [], tags: [] });

    start();
    await advance(0);
    await advance(5_000);
    fireEvent.contextMenu(screen.getByText("Workspace"));
    await advance(0);

    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    expect(mocks.getDetails).not.toHaveBeenCalled();
  });

  it("opens the object a reply links to and shows readable properties", async () => {
    mocks.reference.focusRequest = "game.Workspace.Model.Part";
    const part = {
      ...tree.roots[0],
      name: "Part",
      className: "Part",
      path: "game.Workspace.Model.Part",
    };
    const model = {
      ...tree.roots[0],
      name: "Model",
      className: "Model",
      path: "game.Workspace.Model",
      hasChildren: true,
      children: [part],
    };
    mocks.getSnapshot.mockResolvedValue({
      ...tree,
      roots: [{ ...tree.roots[0], hasChildren: true, children: [model] }],
    });
    mocks.getDetails.mockResolvedValue({
      properties: [
        { name: "Transparency", value: "0.30000001192092896", numeric: true },
        { name: "Size", value: "2048, 16.123456, 2048", numeric: true },
        { name: "Value", value: "1.23456" },
        { name: "Shape", value: "Enum.PartType.Block" },
        { name: "Capabilities", value: "" },
      ],
      attributes: [],
    });

    start();
    await advance(0);

    expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute(
      "data-path",
      "game.Workspace.Model.Part",
    );
    expect(screen.getByText("0.3")).toHaveAttribute("title", "0.3");
    expect(screen.getByText("2048, 16.123, 2048")).toBeInTheDocument();
    expect(screen.getByText("Block")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();
    expect(screen.getByText("1.23456")).toBeInTheDocument();
  });

  it("doesn't follow a rename onto a sibling's name, which could leave it editing the sibling", async () => {
    const sibling = (name: string) => ({
      ...tree.roots[0],
      name,
      className: "Folder",
      path: `game.Workspace.${name}`,
    });
    mocks.getSnapshot.mockResolvedValue({
      ...tree,
      roots: [
        {
          ...tree.roots[0],
          hasChildren: true,
          children: [sibling("Taken"), sibling("Moving")],
        },
      ],
    });
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [] });
    mocks.editObject.mockResolvedValue({ name: "Taken" });

    start();
    await advance(0);
    fireEvent.click(screen.getByText("Moving"));
    await advance(0);
    expect(screen.getByRole("treeitem", { selected: true })).toHaveTextContent("Moving");

    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Moving" });
    fireEvent.change(input, { target: { value: "Taken" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await advance(0);

    expect(mocks.editObject).toHaveBeenCalled();
    expect(screen.queryByRole("treeitem", { selected: true })).not.toBeInTheDocument();
  });

  it("shows what arrives for an object inside the tree, without any other change", async () => {
    mocks.getSnapshot.mockResolvedValue({
      ...tree,
      roots: [{ ...tree.roots[0], hasChildren: true, pending: true }],
    });
    start();
    await advance(0);
    expect(screen.getByText("Loading...")).toBeInTheDocument();

    const kid = { ...tree.roots[0], name: "Kid", path: "game.Workspace.Kid" };
    act(() => {
      for (const listener of mocks.treeListeners) {
        listener({ studioId: "studio-1", parentId: "game.Workspace", children: [kid] });
      }
    });
    await advance(200);

    expect(screen.getByText("Kid")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("doesn't say an object is empty when what's inside it is still loading", async () => {
    mocks.getSnapshot.mockResolvedValue({
      ...tree,
      roots: [
        {
          ...tree.roots[0],
          hasChildren: true,
          children: [
            {
              ...tree.roots[0],
              name: "Big",
              className: "Folder",
              path: "game.Workspace.Big",
              hasChildren: true,
              pending: true,
            },
          ],
        },
      ],
    });
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [] });
    start();
    await advance(0);

    fireEvent.contextMenu(screen.getByText("Big"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(screen.getByRole("alertdialog")).toHaveTextContent("everything inside it");
  });

  it("keeps waiting for a read when a later one has nothing to say", async () => {
    let answerRead: (details: unknown) => void = () => {};
    mocks.getSnapshot.mockResolvedValue(tree);
    mocks.getDetails.mockImplementation(({ background }: { background?: boolean }) =>
      background
        ? Promise.resolve(null)
        : new Promise((resolve) => {
            answerRead = resolve;
          }),
    );

    start();
    await advance(0);
    fireEvent.click(screen.getByText("Workspace"));
    await advance(0);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(0);
    await act(async () => {
      answerRead({
        properties: [{ name: "Gravity", value: "196.2", type: "number", writable: true }],
        attributes: [],
      });
    });
    await advance(0);

    expect(screen.getByText("Gravity")).toBeInTheDocument();
  });

  it("keeps a link waiting until a sync finds an object the chat just added", async () => {
    mocks.reference.focusRequest = "game.Workspace.Part";
    mocks.getSnapshot.mockResolvedValueOnce(tree);
    mocks.getDetails.mockResolvedValue({ properties: [], attributes: [] });

    start();
    await advance(0);
    expect(screen.queryByRole("treeitem", { selected: true })).not.toBeInTheDocument();

    const part = { ...tree.roots[0], name: "Part", className: "Part", path: "game.Workspace.Part" };
    mocks.getSnapshot.mockResolvedValue({
      ...tree,
      roots: [{ ...tree.roots[0], hasChildren: true, children: [part] }],
    });
    await advance(5_000);
    expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute(
      "data-path",
      "game.Workspace.Part",
    );
  });

  describe("with an object in the tree", () => {
    const part = {
      ...tree.roots[0],
      name: "Part",
      className: "Part",
      path: "game.Workspace.Part",
    };
    const withPart = {
      ...tree,
      roots: [{ ...tree.roots[0], hasChildren: true, children: [part] }],
    };
    const row = (name: string) =>
      screen.getAllByRole("treeitem").find((item) => item.textContent === name) as Element;
    const openMenuOn = (name: string) => fireEvent.contextMenu(row(name));
    const startWithPart = async () => {
      mocks.getSnapshot.mockResolvedValue(withPart);
      mocks.getDetails.mockResolvedValue({
        properties: [
          { name: "Anchored", value: "true", type: "boolean", writable: true, category: "Part" },
          {
            name: "Transparency",
            value: "0.30000001192092896",
            type: "number",
            numeric: true,
            writable: true,
            category: "Appearance",
          },
          {
            name: "Position",
            value: "1.2000000476837158, 4, 0",
            type: "Vector3",
            numeric: true,
            writable: true,
            category: "Transform",
          },
          {
            name: "CFrame",
            value: "1, 2, 3, 0, 90.00000000000001, 0",
            type: "CFrame",
            numeric: true,
            writable: true,
            category: "Transform",
          },
          {
            name: "Color",
            value: "1, 0.5, 0",
            type: "Color3",
            numeric: true,
            writable: true,
            category: "Appearance",
          },
          {
            name: "Shape",
            value: "Enum.PartType.Block",
            type: "EnumItem",
            options: ["Ball", "Block"],
            writable: true,
            category: "Part",
          },
          {
            name: "Mass",
            value: "5.599999904632568",
            type: "number",
            numeric: true,
            writable: false,
            category: "Part",
          },
        ],
        attributes: [{ name: "Team", value: "Lobby", type: "string", writable: true }],
      });
      start();
      await advance(0);
    };

    it("lists the name and path as properties and keeps attributes on their own tab", async () => {
      await startWithPart();
      fireEvent.click(row("Part"));
      await advance(0);

      expect(screen.getByRole("tab", { name: "Properties" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByText("ClassName")).toBeInTheDocument();
      expect(screen.getByText("game.Workspace.Part")).toBeInTheDocument();
      expect(screen.getByText("Anchored")).toBeInTheDocument();
      expect(screen.queryByText("Team")).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "Attributes 1" }));
      expect(screen.getByText("Team")).toBeInTheDocument();
      expect(screen.queryByText("Anchored")).not.toBeInTheDocument();
    });

    it("passes the object itself along when referencing it", async () => {
      await startWithPart();
      openMenuOn("Part");
      await advance(0);

      expect(screen.queryByRole("button", { name: "Reference" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("menuitem", { name: "Reference in chat" }));
      expect(mocks.reference.referenceObject).toHaveBeenCalledWith(part);
    });

    it("drags an object by its path, and counts it once it lands", async () => {
      await startWithPart();
      const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "none" };

      fireEvent.dragStart(row("Part"), { dataTransfer });
      expect(dataTransfer.setData).toHaveBeenCalledWith(OBJECT_DRAG_TYPE, part.path);

      const referenced = () =>
        mocks.capture.mock.calls.filter(([event]) => event === "reference_added");
      fireEvent.dragEnd(row("Part"), { dataTransfer });
      expect(referenced()).toHaveLength(0);
      fireEvent.dragEnd(row("Part"), { dataTransfer: { ...dataTransfer, dropEffect: "copy" } });
      expect(referenced()).toHaveLength(1);
    });

    describe("on a property row", () => {
      const rowOf = (name: string) => screen.getByText(name).parentElement as Element;
      const selectPart = async () => {
        await startWithPart();
        fireEvent.click(row("Part"));
        await advance(0);
      };
      const saved = (fields: Record<string, unknown>) =>
        expect(mocks.editObject).toHaveBeenCalledWith(
          "studio-1",
          expect.objectContaining({
            action: "setField",
            path: part.path,
            className: "Part",
            ...fields,
          }),
        );

      it("groups properties by Studio's categories", async () => {
        await selectPart();
        for (const category of ["Appearance", "Transform", "Part"]) {
          expect(screen.getByRole("heading", { name: category })).toBeInTheDocument();
        }
      });

      it("references the property in chat", async () => {
        await selectPart();
        fireEvent.contextMenu(rowOf("Anchored"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Reference in chat" }));

        expect(mocks.reference.referenceObject).toHaveBeenCalledWith({
          ...part,
          field: { kind: "property", name: "Anchored" },
        });
      });

      it("shows the same short number in the row, its tooltip, its editor and the clipboard", async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        await selectPart();

        const value = screen.getByRole("button", { name: "Edit Transparency" });
        expect(value).toHaveTextContent("0.3");
        expect(value).toHaveAttribute("title", "0.3");

        fireEvent.contextMenu(rowOf("Transparency"));
        fireEvent.click(screen.getByRole("menuitem", { name: "Copy value" }));
        expect(writeText).toHaveBeenCalledWith("0.3");

        fireEvent.click(value);
        const input = screen.getByRole("textbox", { name: "Edit Transparency" });
        expect(input).toHaveValue("0.3");

        // Opening it and leaving it alone changes nothing, even though 0.3 isn't the exact value.
        fireEvent.keyDown(input, { key: "Enter" });
        await advance(0);
        expect(mocks.editObject).not.toHaveBeenCalled();
      });

      it("changes one number of a Vector3 and keeps every digit of the others", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Part" });
        const reads = mocks.getDetails.mock.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "Edit Position" }));
        expect(screen.getByRole("textbox", { name: "Position X" })).toHaveValue("1.2");
        fireEvent.change(screen.getByRole("textbox", { name: "Position Y" }), {
          target: { value: "10" },
        });
        fireEvent.keyDown(screen.getByRole("textbox", { name: "Position Y" }), { key: "Enter" });
        await advance(0);

        saved({
          kind: "property",
          field: "Position",
          value: "1.2000000476837158, 10, 0",
          valueType: "Vector3",
        });
        expect(mocks.getDetails.mock.calls.length).toBeGreaterThan(reads);
      });

      it("edits a CFrame as position and orientation", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Part" });

        expect(screen.getByRole("button", { name: "Edit CFrame" })).toHaveTextContent("1, 2, 3");
        fireEvent.click(screen.getByRole("button", { name: "Edit CFrame" }));
        expect(screen.getByRole("textbox", { name: "CFrame Orientation RY" })).toHaveValue("90");
        const x = screen.getByRole("textbox", { name: "CFrame Position X" });
        fireEvent.change(x, { target: { value: "7" } });
        fireEvent.keyDown(x, { key: "Enter" });
        await advance(0);

        saved({ field: "CFrame", value: "7, 2, 3, 0, 90.00000000000001, 0", valueType: "CFrame" });
      });

      it("saves a group of numbers once, only when focus leaves all of them", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Part" });

        fireEvent.click(screen.getByRole("button", { name: "Edit Position" }));
        const x = screen.getByRole("textbox", { name: "Position X" });
        const y = screen.getByRole("textbox", { name: "Position Y" });
        fireEvent.change(x, { target: { value: "5" } });
        fireEvent.blur(x, { relatedTarget: y });
        await advance(0);
        expect(mocks.editObject).not.toHaveBeenCalled();

        fireEvent.blur(y, { relatedTarget: document.body });
        await advance(0);
        expect(mocks.editObject).toHaveBeenCalledTimes(1);
      });

      it("cancels numbers on Escape", async () => {
        await selectPart();
        fireEvent.click(screen.getByRole("button", { name: "Edit Position" }));
        const x = screen.getByRole("textbox", { name: "Position X" });
        fireEvent.change(x, { target: { value: "5" } });
        fireEvent.keyDown(x, { key: "Escape" });
        await advance(0);

        expect(mocks.editObject).not.toHaveBeenCalled();
        expect(screen.queryByRole("textbox", { name: "Position X" })).not.toBeInTheDocument();
      });

      it("picks a boolean from a dropdown", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Part" });

        fireEvent.click(screen.getByRole("button", { name: "Change Anchored" }));
        expect(screen.getByRole("option", { name: "true", selected: true })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("option", { name: "false" }));
        await advance(0);

        saved({ field: "Anchored", value: "false", valueType: "boolean" });
      });

      it("doesn't write when the same choice is picked again", async () => {
        await selectPart();
        fireEvent.click(screen.getByRole("button", { name: "Change Anchored" }));
        fireEvent.click(screen.getByRole("option", { name: "true" }));
        await advance(0);

        expect(mocks.editObject).not.toHaveBeenCalled();
      });

      it("points a property at another object, or at nothing", async () => {
        mocks.reference.objects = [part];
        mocks.getDetails.mockResolvedValue({
          properties: [{ name: "PrimaryPart", value: "", type: "Instance", writable: true }],
          attributes: [],
        });
        mocks.getSnapshot.mockResolvedValue(withPart);
        mocks.editObject.mockResolvedValue({ name: "Part" });
        start();
        await advance(0);
        fireEvent.click(row("Part"));
        await advance(0);

        fireEvent.click(screen.getByRole("button", { name: "Change PrimaryPart" }));
        fireEvent.click(screen.getByRole("option", { name: part.path }));
        await advance(0);

        saved({ field: "PrimaryPart", value: part.path, valueType: "Instance" });
        mocks.reference.objects = [];
      });

      it("saves Faces once, when the list closes", async () => {
        mocks.getDetails.mockResolvedValue({
          properties: [
            { name: "ResizeableFaces", value: "Right, Top", type: "Faces", writable: true },
          ],
          attributes: [],
        });
        mocks.getSnapshot.mockResolvedValue(withPart);
        mocks.editObject.mockResolvedValue({ name: "Part" });
        start();
        await advance(0);
        fireEvent.click(row("Part"));
        await advance(0);

        fireEvent.click(screen.getByRole("button", { name: "Change ResizeableFaces" }));
        fireEvent.click(screen.getByRole("option", { name: "Top" }));
        fireEvent.click(screen.getByRole("option", { name: "Front" }));
        expect(mocks.editObject).not.toHaveBeenCalled();
        fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
        await advance(0);

        saved({ field: "ResizeableFaces", value: "Right, Front", valueType: "Faces" });
      });

      it("edits a Font's weight from a dropdown, keeping its family", async () => {
        mocks.getDetails.mockResolvedValue({
          properties: [
            {
              name: "FontFace",
              value: "rbxasset://fonts/families/Arial.json, Regular, Normal",
              type: "Font",
              writable: true,
            },
          ],
          attributes: [],
        });
        mocks.getSnapshot.mockResolvedValue(withPart);
        mocks.editObject.mockResolvedValue({ name: "Part" });
        start();
        await advance(0);
        fireEvent.click(row("Part"));
        await advance(0);

        fireEvent.click(screen.getByRole("button", { name: "Edit FontFace" }));
        fireEvent.click(screen.getByRole("button", { name: "FontFace weight" }));
        fireEvent.click(screen.getByRole("option", { name: "Bold" }));
        await advance(0);

        saved({
          field: "FontFace",
          value: "rbxasset://fonts/families/Arial.json, Bold, Normal",
          valueType: "Font",
        });
      });

      it("picks an enum value from its real options", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Part" });

        fireEvent.click(screen.getByRole("button", { name: "Change Shape" }));
        fireEvent.click(screen.getByRole("option", { name: "Ball" }));
        await advance(0);

        saved({ field: "Shape", value: "Ball", valueType: "EnumItem" });
      });

      describe("the color picker", () => {
        const openPicker = async () => {
          await selectPart();
          mocks.editObject.mockResolvedValue({ name: "Part" });
          const trigger = screen.getByRole("button", { name: "Change Color" });
          expect(trigger).toHaveTextContent("255, 128, 0");
          fireEvent.click(trigger);
          return trigger;
        };

        it("saves once when it closes, in Studio's 0 to 1", async () => {
          const trigger = await openPicker();
          fireEvent.change(screen.getByRole("textbox", { name: "Color B" }), {
            target: { value: "51" },
          });
          fireEvent.change(screen.getByRole("textbox", { name: "Color R" }), {
            target: { value: "0" },
          });
          expect(mocks.editObject).not.toHaveBeenCalled();
          fireEvent.click(trigger);
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledTimes(1);
          saved({ field: "Color", value: `0, ${128 / 255}, 0.2`, valueType: "Color3" });
        });

        it("takes a hex color", async () => {
          const trigger = await openPicker();
          fireEvent.change(screen.getByRole("textbox", { name: "Color hex" }), {
            target: { value: "#00ff00" },
          });
          fireEvent.click(trigger);
          await advance(0);

          saved({ field: "Color", value: "0, 1, 0", valueType: "Color3" });
        });

        it("writes nothing when closed unchanged, or on Escape", async () => {
          const trigger = await openPicker();
          fireEvent.click(trigger);
          await advance(0);

          fireEvent.click(trigger);
          fireEvent.change(screen.getByRole("textbox", { name: "Color hex" }), {
            target: { value: "#00ff00" },
          });
          fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
          await advance(0);

          expect(mocks.editObject).not.toHaveBeenCalled();
        });
      });

      it("picks a BrickColor from swatches", async () => {
        mocks.getDetails.mockResolvedValue({
          properties: [
            {
              name: "BrickColor",
              value: "Bright red",
              type: "BrickColor",
              writable: true,
              options: ["Bright red", "Bright blue"],
              swatches: ["#c4281c", "#0d69ac"],
            },
          ],
          attributes: [],
        });
        mocks.getSnapshot.mockResolvedValue(withPart);
        mocks.editObject.mockResolvedValue({ name: "Part" });
        start();
        await advance(0);
        fireEvent.click(row("Part"));
        await advance(0);

        fireEvent.click(screen.getByRole("button", { name: "Change BrickColor" }));
        const blue = screen.getByRole("option", { name: "Bright blue" });
        expect(blue).toHaveStyle({ backgroundColor: "#0d69ac" });
        fireEvent.click(blue);
        await advance(0);

        saved({ field: "BrickColor", value: "Bright blue", valueType: "BrickColor" });
      });

      it("doesn't offer to edit a read-only property", async () => {
        await selectPart();
        expect(screen.queryByRole("button", { name: "Edit Mass" })).not.toBeInTheDocument();
        fireEvent.contextMenu(rowOf("Mass"));
        expect(screen.getByRole("menuitem", { name: "Copy value" })).toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: "Edit value" })).not.toBeInTheDocument();
      });

      it("renames from the Name row, like the tree does", async () => {
        await selectPart();
        mocks.editObject.mockResolvedValue({ name: "Door" });
        fireEvent.click(screen.getByRole("button", { name: "Edit Name" }));
        const input = screen.getByRole("textbox", { name: "Edit Name" });
        fireEvent.change(input, { target: { value: "Door" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await advance(0);

        expect(mocks.editObject).toHaveBeenCalledWith(
          "studio-1",
          expect.objectContaining({ action: "rename", name: "Door", path: part.path }),
        );
      });

      it("doesn't offer to edit a service's name, or anyone's class or path", async () => {
        await startWithPart();
        fireEvent.click(row("Workspace"));
        await advance(0);
        expect(screen.queryByRole("button", { name: "Edit Name" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Edit ClassName" })).not.toBeInTheDocument();
        fireEvent.contextMenu(rowOf("ClassName"));
        expect(screen.queryByRole("menuitem", { name: "Edit value" })).not.toBeInTheDocument();
      });

      it("explains missing values while Studio has something to redo", async () => {
        await startWithPart();
        mocks.getDetails.mockResolvedValue({ limited: "redo", properties: [], attributes: [] });
        fireEvent.click(row("Part"));
        await advance(0);

        expect(screen.getByText(/Studio has something to redo/)).toBeInTheDocument();
      });

      it("won't change what it couldn't read for sure", async () => {
        await startWithPart();
        mocks.getDetails.mockResolvedValue({
          locked: true,
          properties: [{ name: "Anchored", value: "true", type: "boolean", writable: false }],
          attributes: [],
        });
        fireEvent.click(row("Part"));
        await advance(0);

        expect(screen.getByText(/first 20 objects/)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Change Anchored" })).not.toBeInTheDocument();
      });

      describe("on the tags tab", () => {
        const openTags = async () => {
          mocks.getSnapshot.mockResolvedValue(withPart);
          mocks.getDetails.mockResolvedValue({
            properties: [],
            attributes: [],
            tags: ["Enemy"],
            placeTags: ["Enemy", "Boss", "Coin"],
          });
          mocks.editObject.mockResolvedValue({ name: "Part" });
          start();
          await advance(0);
          fireEvent.click(row("Part"));
          await advance(0);
          fireEvent.click(screen.getByRole("tab", { name: "Tags 1" }));
        };
        const target = { path: part.path, className: "Part" };

        it("adds a tag by name", async () => {
          await openTags();
          fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
          const name = screen.getByRole("textbox", { name: "Tag name" });

          fireEvent.change(name, { target: { value: "Enemy" } });
          expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
          fireEvent.change(name, { target: { value: "  Has Space " } });
          fireEvent.click(screen.getByRole("button", { name: "Add" }));
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
            action: "addTag",
            field: "Has Space",
            ...target,
          });
        });

        it("suggests tags used elsewhere in the place", async () => {
          await openTags();
          fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
          expect(screen.queryByRole("button", { name: "Enemy" })).not.toBeInTheDocument();
          fireEvent.click(screen.getByRole("button", { name: "Boss" }));
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
            action: "addTag",
            field: "Boss",
            ...target,
          });
        });

        it("removes a tag", async () => {
          await openTags();
          fireEvent.click(screen.getByRole("button", { name: "Remove tag Enemy" }));
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
            action: "removeTag",
            field: "Enemy",
            ...target,
          });
        });

        it("references a tag from its menu", async () => {
          await openTags();
          fireEvent.contextMenu(screen.getByText("Enemy").parentElement as Element);
          fireEvent.click(screen.getByRole("menuitem", { name: "Reference in chat" }));

          expect(mocks.reference.referenceObject).toHaveBeenCalledWith({
            ...part,
            field: { kind: "tag", name: "Enemy" },
          });
          expect(screen.queryByRole("menuitem", { name: "Edit value" })).not.toBeInTheDocument();
        });

        it("doesn't claim there are no tags when they couldn't be read", async () => {
          mocks.getSnapshot.mockResolvedValue(withPart);
          mocks.getDetails.mockResolvedValue({ limited: "redo", properties: [], attributes: [] });
          start();
          await advance(0);
          fireEvent.click(row("Part"));
          await advance(0);
          fireEvent.click(screen.getByRole("tab", { name: "Tags" }));

          expect(screen.queryByText("No tags.")).not.toBeInTheDocument();
          expect(screen.queryByRole("button", { name: "Add tag" })).not.toBeInTheDocument();
          expect(screen.getByText(/Tags and some values are hidden/)).toBeInTheDocument();
        });
      });

      describe("on the attributes tab", () => {
        const openAttributes = async () => {
          await selectPart();
          mocks.editObject.mockResolvedValue({ name: "Part" });
          fireEvent.click(screen.getByRole("tab", { name: "Attributes 1" }));
        };

        it("changes attributes as attributes", async () => {
          await openAttributes();
          fireEvent.click(screen.getByRole("button", { name: "Edit Team" }));
          const input = screen.getByRole("textbox", { name: "Edit Team" });
          fireEvent.change(input, { target: { value: "Red" } });
          fireEvent.keyDown(input, { key: "Enter" });
          await advance(0);

          saved({ kind: "attribute", field: "Team", value: "Red", valueType: "string" });
        });

        it("references an attribute as an attribute", async () => {
          await openAttributes();
          fireEvent.contextMenu(rowOf("Team"));
          fireEvent.click(screen.getByRole("menuitem", { name: "Reference in chat" }));

          expect(mocks.reference.referenceObject).toHaveBeenCalledWith({
            ...part,
            field: { kind: "attribute", name: "Team" },
          });
        });

        it("adds an attribute, refusing a name Roblox wouldn't take", async () => {
          await openAttributes();
          fireEvent.click(screen.getByRole("button", { name: "Add attribute" }));
          const name = screen.getByRole("textbox", { name: "Attribute name" });

          fireEvent.change(name, { target: { value: "not allowed" } });
          expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
          fireEvent.change(name, { target: { value: "Team" } });
          expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

          fireEvent.change(name, { target: { value: "Speed" } });
          fireEvent.click(screen.getByRole("button", { name: "Add" }));
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
            action: "addAttribute",
            field: "Speed",
            valueType: "string",
            path: part.path,
            className: "Part",
          });
        });

        it("removes an attribute", async () => {
          await openAttributes();
          fireEvent.contextMenu(rowOf("Team"));
          fireEvent.click(screen.getByRole("menuitem", { name: "Remove attribute" }));
          await advance(0);

          expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
            action: "removeAttribute",
            field: "Team",
            path: part.path,
            className: "Part",
          });
        });
      });
    });

    it("doesn't offer to change a service", async () => {
      await startWithPart();
      openMenuOn("Workspace");

      expect(screen.getByRole("menuitem", { name: "Reference in chat" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    });

    it("renames an object in place and follows it to its new path", async () => {
      await startWithPart();
      mocks.editObject.mockResolvedValue({ name: "Door" });
      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

      const input = screen.getByRole("textbox", { name: "Rename Part" });
      fireEvent.change(input, { target: { value: "  Door " } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
      mocks.getSnapshot.mockResolvedValue({
        ...withPart,
        roots: [
          {
            ...withPart.roots[0],
            children: [{ ...part, name: "Door", path: "game.Workspace.Door" }],
          },
        ],
      });
      await advance(0);

      expect(mocks.editObject).toHaveBeenCalledTimes(1);
      expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
        action: "rename",
        name: "Door",
        path: "game.Workspace.Part",
        className: "Part",
      });
      expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute(
        "data-path",
        "game.Workspace.Door",
      );
    });

    it("cancels a rename on Escape or when nothing changed", async () => {
      await startWithPart();
      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Part" }), { key: "Escape" });

      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Part" }), { key: "Enter" });

      await advance(0);
      expect(mocks.editObject).not.toHaveBeenCalled();
    });

    it("only deletes after asking", async () => {
      await startWithPart();
      mocks.editObject.mockResolvedValue({ name: "Part" });
      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(mocks.editObject).not.toHaveBeenCalled();

      const dialog = screen.getByRole("alertdialog");
      expect(dialog).toHaveTextContent("Delete Part?");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mocks.editObject).not.toHaveBeenCalled();

      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await advance(0);
      expect(mocks.editObject).toHaveBeenCalledWith("studio-1", {
        action: "delete",
        path: "game.Workspace.Part",
        className: "Part",
      });
    });

    it("explains when the place changed under a row", async () => {
      await startWithPart();
      mocks.editObject.mockRejectedValue(new Error("Found 2 objects at this path"));
      openMenuOn("Part");
      fireEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
      await advance(0);

      expect(mocks.notifyError).toHaveBeenCalledWith("Couldn't duplicate Part", {
        description: expect.stringContaining("nothing was edited"),
      });
    });

    it("selects and edits each of two objects with the same path on its own", async () => {
      const twin = { ...part, name: "Twin", path: "game.Workspace.Twin", occurrences: 2 };
      mocks.getSnapshot.mockResolvedValue({
        ...tree,
        roots: [
          {
            ...tree.roots[0],
            hasChildren: true,
            children: [
              { ...twin, id: "game.Workspace.Twin", occurrence: 0 },
              { ...twin, id: "game.Workspace.Twin#1", occurrence: 1 },
            ],
          },
        ],
      });
      mocks.getDetails.mockResolvedValue({ properties: [], attributes: [] });
      mocks.editObject.mockResolvedValue({ name: "Twin" });
      start();
      await advance(0);

      const rows = screen.getAllByRole("treeitem").filter((item) => item.textContent === "Twin");
      expect(rows).toHaveLength(2);
      fireEvent.click(rows[1]);
      await advance(0);
      expect(rows[1]).toHaveAttribute("aria-selected", "true");
      expect(rows[0]).toHaveAttribute("aria-selected", "false");
      expect(mocks.getDetails).toHaveBeenLastCalledWith(
        "studio-1",
        expect.objectContaining({ path: twin.path, occurrence: 1, occurrences: 2 }),
      );

      fireEvent.contextMenu(rows[1]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await advance(0);
      expect(mocks.editObject).toHaveBeenCalledWith(
        "studio-1",
        expect.objectContaining({ action: "delete", occurrence: 1, occurrences: 2 }),
      );
    });

    it("re-reads on focus in the background, so it can't clear Studio's redo", async () => {
      await startWithPart();
      fireEvent.click(row("Part"));
      await advance(0);

      window.dispatchEvent(new Event("focus"));
      await advance(0);

      expect(mocks.getDetails).toHaveBeenLastCalledWith(
        "studio-1",
        expect.objectContaining({ path: part.path, background: true }),
      );
    });
  });

  it("only links a bare name when one object has it", () => {
    const part = (path: string) => ({ ...tree.roots[0], name: "Part", path });
    const index = indexExplorerObjects([
      {
        ...tree.roots[0],
        children: [part("game.Workspace.Part"), part("game.Workspace.Other.Part")],
      },
    ]);
    expect(index.get("Part")).toBeNull();
    expect(index.get("Workspace.Part")?.path).toBe("game.Workspace.Part");
    expect(index.get("game.Workspace.Part")?.path).toBe("game.Workspace.Part");
    expect(index.get("Workspace")?.path).toBe("game.Workspace");
  });
});
