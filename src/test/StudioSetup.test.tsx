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
        name: "The Baseplate template on the Roblox Studio home screen",
      }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Assistant" })).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "An open Roblox Studio place with the Assistant button in the top-right corner",
      }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Manage MCP Servers" })).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "The Roblox Studio Assistant menu with Manage MCP Servers selected",
      }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("heading", { name: "Enable Studio as MCP server" })).toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "Roblox Studio Assistant Settings with Enable Studio as MCP server turned on",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByText(/Connect BloxBot|Studio connection|Ready for BloxBot/)).toBeNull();
  });

  it("celebrates when Studio connects", () => {
    const onContinue = vi.fn();
    render(<StudioSetup connected checking={false} onCheck={vi.fn()} onContinue={onContinue} />);

    expect(screen.getByRole("heading", { name: "Studio connected" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Let's build" }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
