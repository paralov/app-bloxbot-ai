import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compile: vi.fn(),
  invoke: vi.fn(),
  resolvePrograms: vi.fn(),
  capture: vi.fn(),
  prompt: vi.fn(),
  // Stable, as the real providers' values are: a new one each render restarts Explorer's sync.
  client: {},
  studioTarget: { selected: { key: "studio-1" } },
  reference: { referenceObject: () => {}, publishObjects: () => {} },
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: mocks.capture },
}));
vi.mock("@/lib/desktop", () => ({
  desktop: {
    compileExplorerProgram: mocks.compile,
    invokeExplorerProgram: mocks.invoke,
    onBloxBotProgramsUpdated: () => () => {},
  },
}));
vi.mock("@/lib/bloxbotPrograms", () => ({
  BUILTIN_BLOXBOT_PROGRAMS: { explorer: { source: "builtin", program: "builtin-program" } },
  resolveBloxBotPrograms: mocks.resolvePrograms,
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

const tree = {
  placeName: "Obby",
  capturedAt: "2026-11-02T12:00:00Z",
  roots: [
    {
      name: "Workspace",
      className: "Workspace",
      path: "Workspace",
      hasChildren: false,
      properties: [],
      attributes: [],
      children: [],
    },
  ],
};

const builtin = { explorer: { source: "builtin", program: "builtin-program" } };
const published = { explorer: { source: "published", program: "published-program", sequence: 4 } };

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe("Explorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.client = { session: { prompt: mocks.prompt } };
    mocks.compile.mockImplementation(async (program: string) => ({ program }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const onToggle = () => {};
  const start = () =>
    render(<Explorer collapsed={false} sessionBusy={false} onToggle={onToggle} />);

  it("retries a failed setup on its own, and never asks the model", async () => {
    mocks.resolvePrograms.mockResolvedValue(builtin);
    mocks.invoke.mockRejectedValueOnce(new Error("Studio has not returned a tree"));
    mocks.invoke.mockResolvedValue(tree);

    start();
    await advance(0);
    expect(screen.getByText(/Trying again shortly/)).toBeInTheDocument();

    await advance(10_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.queryByText(/Trying again shortly/)).not.toBeInTheDocument();
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("falls back from a broken published program to the shipped one", async () => {
    mocks.resolvePrograms.mockResolvedValue(published);
    mocks.invoke.mockImplementation(async (artifact: { program: string }) => {
      if (artifact.program === "published-program") throw new Error("Published program broke");
      return tree;
    });

    start();
    await advance(0);

    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(mocks.compile).toHaveBeenLastCalledWith("builtin-program");
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it("keeps the tree on screen when a later sync fails, then recovers", async () => {
    mocks.resolvePrograms.mockResolvedValue(builtin);
    mocks.invoke.mockResolvedValueOnce(tree);

    start();
    await advance(0);
    expect(screen.getByText("Workspace")).toBeInTheDocument();

    mocks.invoke.mockRejectedValueOnce(new Error("Studio went away"));
    await advance(5_000);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText(/Trying again shortly/)).toBeInTheDocument();

    mocks.invoke.mockResolvedValue(tree);
    await advance(10_000);
    expect(screen.queryByText(/Trying again shortly/)).not.toBeInTheDocument();
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(mocks.compile).toHaveBeenCalledOnce();
  });
});
