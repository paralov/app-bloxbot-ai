import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  capture: vi.fn(),
  // Stable, as the real providers' values are: a new one each render restarts Explorer's sync.
  client: {},
  studioTarget: { selected: { key: "studio-1" } },
  reference: { referenceObject: () => {}, publishObjects: () => {} },
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture },
}));
vi.mock("@/lib/desktop", () => ({ desktop: { getExplorerSnapshot: mocks.getSnapshot } }));
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
});
