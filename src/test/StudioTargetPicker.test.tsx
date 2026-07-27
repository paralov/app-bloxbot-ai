import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  discoverStudioTargets,
  selectStudioTarget,
  installStudioTargetPrograms,
  capture,
  loadConfig,
  generatePrograms,
  client,
} = vi.hoisted(() => ({
  discoverStudioTargets: vi.fn(),
  selectStudioTarget: vi.fn(),
  installStudioTargetPrograms: vi.fn(),
  capture: vi.fn(),
  loadConfig: vi.fn(),
  generatePrograms: vi.fn(),
  client: {},
}));

const programs = { discovery: {}, selection: {} };

vi.mock("@/lib/desktop", () => ({
  desktop: {
    discoverStudioTargets,
    selectStudioTarget,
    loadConfig,
    patchConfig: vi.fn(),
    installStudioTargetPrograms,
  },
}));

vi.mock("@/lib/studioTargetPrograms", () => ({ generateStudioTargetPrograms: generatePrograms }));
vi.mock("@/providers/OpenCodeClientProvider", () => ({ useOpenCodeClient: () => ({ client }) }));
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
    loadConfig.mockResolvedValue({ studioTargetPrograms: programs });
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

  it("handles no Studios and discovery errors", async () => {
    discoverStudioTargets.mockResolvedValueOnce({ targets: [], selectedKey: null });
    renderPicker();
    fireEvent.click(await screen.findByRole("button", { name: /No Studios/ }));
    expect(screen.getByText("No Studio windows found")).toBeVisible();

    discoverStudioTargets.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Couldn’t find Studios")).toBeVisible();
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
});
