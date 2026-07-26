import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import StudioPlacePicker from "@/components/StudioPlacePicker";

const mocks = vi.hoisted(() => ({
  assignments: {} as Record<string, { id: string; name: string }>,
  setAssignment: vi.fn().mockResolvedValue(undefined),
  refetch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useStudioAssignments", () => ({
  useStudioAssignments: () => ({
    assignments: mocks.assignments,
    setAssignment: mocks.setAssignment,
  }),
}));

vi.mock("@/hooks/useStudioPlaces", () => ({
  useStudioPlaces: () => ({
    data: [
      { id: "studio-1", name: "Place1", active: false },
      { id: "studio-2", name: "Place1", active: false },
    ],
    error: null,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }),
}));

describe("StudioPlacePicker", () => {
  beforeEach(() => {
    mocks.assignments = {};
    mocks.setAssignment.mockClear();
    mocks.refetch.mockClear();
  });

  it("always shows automatic selection as the active default option", async () => {
    render(<StudioPlacePicker sessionID="s1" />);

    expect(screen.getByText("Automatic selection")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Assign this session to a Roblox Studio place"));

    const automaticOptions = screen.getAllByText("Automatic selection");
    expect(automaticOptions).toHaveLength(2);
    fireEvent.click(automaticOptions[1]);

    await waitFor(() => expect(mocks.setAssignment).toHaveBeenCalledWith("s1", null));
  });
});
