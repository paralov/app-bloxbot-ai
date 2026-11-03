import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  getDetails: vi.fn(),
  capture: vi.fn(),
  // Stable, as the real providers' values are: a new one each render restarts Explorer's sync.
  client: {},
  studioTarget: { selected: { key: "studio-1" } },
  reference: {
    referenceObject: () => {},
    publishObjects: () => {},
    focusRequest: null as string | null,
    consumeFocus: () => {},
  },
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture },
}));
vi.mock("@/lib/desktop", () => ({
  desktop: { getExplorerSnapshot: mocks.getSnapshot, getExplorerNodeDetails: mocks.getDetails },
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: mocks.client }),
}));
vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => mocks.studioTarget,
}));
vi.mock("@/providers/ExplorerReferenceProvider", () => ({
  useExplorerReference: () => mocks.reference,
}));

import Explorer from "@/components/Explorer";
import { indexExplorerObjects } from "@/lib/explorer";

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
    render(<Explorer collapsed={false} sessionBusy={false} onToggle={onToggle} />);

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
    expect(screen.getByText(/Trying again shortly/)).toBeInTheDocument();

    await advance(10_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText(/Trying again shortly/)).not.toBeInTheDocument();
  });

  it("treats an empty first tree as not ready yet", async () => {
    mocks.getSnapshot.mockResolvedValueOnce({ ...tree, roots: [] });
    mocks.getSnapshot.mockResolvedValue(tree);

    start();
    await advance(0);
    expect(screen.getByText(/Trying again shortly/)).toBeInTheDocument();

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
    expect(screen.getByText(/Trying again shortly/)).toBeInTheDocument();

    mocks.getSnapshot.mockResolvedValue(tree);
    await advance(10_000);
    expect(screen.queryByText(/Trying again shortly/)).not.toBeInTheDocument();
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
        { name: "Name", value: "007" },
      ],
      attributes: [],
    });

    start();
    await advance(0);

    expect(screen.getByRole("treeitem", { selected: true })).toHaveAttribute(
      "data-path",
      "game.Workspace.Model.Part",
    );
    expect(screen.getByText("0.3")).toHaveAttribute("title", "0.30000001192092896");
    expect(screen.getByText("2048, 16.123, 2048")).toBeInTheDocument();
    expect(screen.getByText("Block")).toBeInTheDocument();
    expect(screen.queryByText("Capabilities")).not.toBeInTheDocument();
    expect(screen.getByText("007")).toBeInTheDocument();
    expect(screen.getByText("1.23456")).toBeInTheDocument();
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
