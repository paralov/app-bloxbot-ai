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
