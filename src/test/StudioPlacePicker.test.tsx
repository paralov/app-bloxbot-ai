import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StudioPlacePicker from "@/components/StudioPlacePicker";

const mocks = vi.hoisted(() => ({
  assignments: {} as Record<string, { id: string; name: string }>,
  setAssignment: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@/hooks/useStudioAssignments", () => ({
  useStudioAssignments: () => ({
    assignments: mocks.assignments,
    setAssignment: mocks.setAssignment,
  }),
}));
vi.mock("@/hooks/useStudioPlaces", () => ({
  useStudioPlaces: () => ({
    data: [{ id: "studio-1", name: "Lobby", active: true }],
    isFetching: false,
    refetch: mocks.refetch,
  }),
}));

describe("StudioPlacePicker", () => {
  beforeEach(() => {
    mocks.assignments = {};
    mocks.setAssignment.mockResolvedValue(undefined);
  });

  it("defaults to automatic selection and assigns a place", async () => {
    render(<StudioPlacePicker sessionID="s1" />);
    const select = screen.getByRole("combobox", { name: "Roblox Studio place" });
    expect(select).toHaveValue("");
    fireEvent.change(select, { target: { value: "studio-1" } });
    await waitFor(() =>
      expect(mocks.setAssignment).toHaveBeenCalledWith("s1", { id: "studio-1", name: "Lobby" }),
    );
  });

  it("is disabled while the session is working", () => {
    render(<StudioPlacePicker sessionID="s1" disabled />);
    expect(screen.getByRole("combobox", { name: "Roblox Studio place" })).toBeDisabled();
  });
});
