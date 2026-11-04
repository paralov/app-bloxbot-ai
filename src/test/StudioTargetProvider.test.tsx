import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discover: vi.fn(),
  select: vi.fn(),
  loadConfig: vi.fn(),
  patchConfig: vi.fn(),
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
  default: { capture: vi.fn(), register: vi.fn() },
}));

import { StudioTargetProvider, useStudioTargetOptional } from "@/providers/StudioTargetProvider";

/** Writes down every target the app was told to read, which the Explorer would have read at once. */
function Seen({ keys }: { keys: Array<string | null> }) {
  const key = useStudioTargetOptional()?.selected?.key ?? null;
  keys.push(key);
  return <div>selected: {key ?? "none"}</div>;
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

    await waitFor(() => expect(mocks.discover).toHaveBeenCalled());
    expect(await screen.findByText("selected: none")).toBeInTheDocument();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.patchConfig).not.toHaveBeenCalled();
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
