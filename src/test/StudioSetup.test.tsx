import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import StudioSetup from "@/components/StudioSetup";

describe("StudioSetup", () => {
  it("walks through the short Studio setup flow", () => {
    render(
      <StudioSetup connected={false} checking={false} onCheck={vi.fn()} onContinue={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Open a place" })).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "A playful representation of an open Roblox Studio project",
      }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Find MCP Servers" })).toBeVisible();
    expect(screen.getByText("Manage MCP Servers")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Flip the switch" })).toBeVisible();
    expect(screen.getByText("Studio connection")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("celebrates when Studio connects", () => {
    const onContinue = vi.fn();
    render(<StudioSetup connected checking={false} onCheck={vi.fn()} onContinue={onContinue} />);

    expect(screen.getByRole("heading", { name: "Studio connected" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Let's build" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
