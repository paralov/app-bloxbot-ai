import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoadingScreen from "@/components/LoadingScreen";
import { getStartupPresentation, type StartupPhase } from "@/providers/OpenCodeClientProvider";

describe("startup progress", () => {
  it.each([
    ["engine", "Waking things up", "sparkles"],
    ["connection", "Connecting the dots", "dots"],
    ["workspace", "Setting the stage", "blocks"],
  ] as const)("gives the %s phase a short message and playful animation", (phase: StartupPhase, message, animation) => {
    expect(getStartupPresentation(phase)).toEqual({ message, animation });
  });

  it("shows only the short progress message", () => {
    const startup = getStartupPresentation("connection");
    const { container } = render(<LoadingScreen {...startup} />);

    expect(screen.getByRole("heading", { name: "Connecting the dots" })).toBeVisible();
    expect(container.querySelector(".startup-connecting")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenCode/i)).not.toBeInTheDocument();
  });
});
