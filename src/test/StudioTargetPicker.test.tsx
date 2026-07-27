import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  discoverStudioTargets,
  selectStudioTarget,
  installStudioTargetPrograms,
  patchConfig,
  capture,
  loadConfig,
  generatePrograms,
  client,
  activeSession,
} = vi.hoisted(() => ({
  discoverStudioTargets: vi.fn(),
  selectStudioTarget: vi.fn(),
  installStudioTargetPrograms: vi.fn(),
  patchConfig: vi.fn(),
  capture: vi.fn(),
  loadConfig: vi.fn(),
  generatePrograms: vi.fn(),
  client: {},
  activeSession: { id: "chat-session" },
}));

const programs = { discovery: {}, selection: {} };

vi.mock("@/lib/desktop", () => ({
  desktop: {
    discoverStudioTargets,
    selectStudioTarget,
    loadConfig,
    patchConfig,
    installStudioTargetPrograms,
  },
}));

vi.mock("@/lib/studioTargetPrograms", () => ({ generateStudioTargetPrograms: generatePrograms }));
vi.mock("@/providers/OpenCodeClientProvider", () => ({ useOpenCodeClient: () => ({ client }) }));
vi.mock("@/providers/ActiveSessionProvider", () => ({
  useActiveSession: () => ({ activeSessionId: activeSession.id }),
}));
vi.mock("@/providers/PreferencesProvider", () => ({
  usePreferences: () => ({ selectedModel: null, selectedAgent: null }),
}));

vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture },
}));

import StudioTargetPicker from "@/components/StudioTargetPicker";
import { StudioTargetProvider } from "@/providers/StudioTargetProvider";

function renderPicker() {
  return render(
    <StudioTargetProvider>
      <StudioTargetPicker />
    </StudioTargetProvider>,
  );
}

describe("StudioTargetPicker", () => {
  beforeEach(() => {
    discoverStudioTargets.mockReset();
    selectStudioTarget.mockReset();
    capture.mockReset();
    patchConfig.mockReset();
    activeSession.id = "chat-session";
    loadConfig.mockResolvedValue({ studioTargetPrograms: programs, studioTargetsBySession: {} });
    installStudioTargetPrograms.mockResolvedValue(programs);
    generatePrograms.mockRejectedValue(new Error("generation failed"));
  });

  it("auto-selects a single Studio and reports only a count bucket", async () => {
    discoverStudioTargets.mockResolvedValue({
      targets: [{ key: "private-session-id", label: "Obby", detail: "Editing" }],
      selectedKey: null,
    });
    selectStudioTarget.mockResolvedValue({
      selected: { key: "private-session-id", label: "Obby", detail: "Editing" },
      verified: true,
    });
    renderPicker();

    expect(await screen.findByRole("button", { name: /Obby/ })).toBeVisible();
    expect(capture).toHaveBeenCalledWith("studio_target_discovery_succeeded", {
      analytics_schema_version: 1,
      count_bucket: "1",
      feature: "studio_target",
      outcome: "success",
      selected: true,
    });
    expect(selectStudioTarget).toHaveBeenCalledWith(programs, "private-session-id");
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private-session-id");
    expect(JSON.stringify(capture.mock.calls)).not.toContain("Obby");
  });

  it("lists multiple Studios and verifies a new selection", async () => {
    discoverStudioTargets.mockResolvedValue({
      targets: [
        { key: "one", label: "Lobby", detail: null },
        { key: "two", label: "Dungeon", detail: "Team Create" },
      ],
      selectedKey: "one",
    });
    selectStudioTarget.mockResolvedValue({
      selected: { key: "two", label: "Dungeon", detail: "Team Create" },
      verified: true,
    });
    renderPicker();

    fireEvent.click(await screen.findByRole("button", { name: /Lobby/ }));
    fireEvent.click(screen.getByRole("button", { name: /Dungeon/ }));

    await waitFor(() => expect(selectStudioTarget).toHaveBeenCalledWith(programs, "two"));
    expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("Dungeon");
    expect(capture).toHaveBeenCalledWith("studio_target_verification_succeeded", {
      analytics_schema_version: 1,
      feature: "studio_target",
      outcome: "success",
      selection_mode: "manual",
    });
  });

  it("keeps the current targets visible while refreshing", async () => {
    let finishRefresh!: (value: unknown) => void;
    const refresh = new Promise((resolve) => {
      finishRefresh = resolve;
    });
    discoverStudioTargets
      .mockResolvedValueOnce({
        targets: [
          { key: "one", label: "Lobby", detail: null },
          { key: "two", label: "Dungeon", detail: null },
        ],
        selectedKey: "one",
      })
      .mockReturnValueOnce(refresh);

    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /Lobby/ }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(screen.getAllByRole("button", { name: /Lobby/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Dungeon/ })).toBeVisible();
    expect(screen.queryByLabelText("Loading Studio targets")).not.toBeInTheDocument();

    finishRefresh({
      targets: [
        { key: "one", label: "Lobby", detail: null },
        { key: "two", label: "Dungeon", detail: null },
      ],
      selectedKey: "one",
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
  });

  it("handles no Studios and discovery errors", async () => {
    discoverStudioTargets.mockResolvedValueOnce({ targets: [], selectedKey: null });
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /No Studios/ }));
    expect(screen.getByText("No Studio windows found")).toBeVisible();

    discoverStudioTargets.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn’t find Studios")).toBeVisible();
    expect(
      screen.getByText("Studio integration setup failed. Refresh to try again."),
    ).toBeVisible();
  });

  it("keeps the prior target when verification fails", async () => {
    discoverStudioTargets.mockResolvedValue({
      targets: [
        { key: "one", label: "Lobby", detail: null },
        { key: "two", label: "Dungeon", detail: null },
      ],
      selectedKey: "one",
    });
    selectStudioTarget.mockRejectedValue(new Error("stale"));
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /Lobby/ }));
    fireEvent.click(screen.getByRole("button", { name: /Dungeon/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no longer available");
    expect(screen.getByRole("button", { expanded: true })).toHaveTextContent("Lobby");
  });

  it("restores a session target by place name when its Studio id changes", async () => {
    loadConfig.mockResolvedValue({
      studioTargetPrograms: programs,
      studioTargetsBySession: {
        "chat-session": { key: "old-id", label: "Dungeon", detail: null },
      },
    });
    discoverStudioTargets.mockResolvedValue({
      targets: [
        { key: "new-id", label: "Dungeon", detail: null },
        { key: "lobby-id", label: "Lobby", detail: null },
      ],
      selectedKey: "lobby-id",
    });
    selectStudioTarget.mockResolvedValue({
      selected: { key: "new-id", label: "Dungeon", detail: "Active" },
      verified: true,
    });

    renderPicker();

    expect(await screen.findByRole("button", { name: /Dungeon/ })).toBeVisible();
    expect(selectStudioTarget).toHaveBeenCalledWith(programs, "new-id");
    expect(patchConfig).toHaveBeenCalledWith({
      studioTargetsBySession: {
        "chat-session": { key: "new-id", label: "Dungeon", detail: "Active" },
      },
    });
  });
});
