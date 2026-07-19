import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoadingScreen from "@/components/LoadingScreen";
import { getStartupPresentation, type StartupPhase } from "@/providers/OpenCodeClientProvider";

describe("startup progress", () => {
  it.each([
    ["engine", 0],
    ["connection", 1],
    ["workspace", 2],
  ] as const)("marks the %s phase as active", (phase: StartupPhase, activeIndex: number) => {
    const { steps } = getStartupPresentation(phase);

    expect(steps.map((step) => step.status)).toEqual(
      steps.map((_, index) =>
        index < activeIndex ? "complete" : index === activeIndex ? "active" : "pending",
      ),
    );
  });

  it("explains the current work and the underlying startup steps", () => {
    const startup = getStartupPresentation("connection");

    render(
      <LoadingScreen
        {...startup}
        note="OpenCode starts as a private service that only listens on this device."
      />,
    );

    expect(screen.getByRole("heading", { name: "Connecting to the AI engine" })).toBeVisible();
    expect(
      screen.getByText("OpenCode is running. BloxBot is confirming the private local connection."),
    ).toBeVisible();

    const steps = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[1]).toHaveAttribute("aria-current", "step");
    expect(
      within(steps[0]).getByText("Verify the runtime and start the private local service."),
    ).toBeVisible();
    expect(
      within(steps[2]).getByText("Load sessions, providers, models, agents, and status."),
    ).toBeVisible();
    expect(
      screen.getByText("OpenCode starts as a private service that only listens on this device."),
    ).toBeVisible();
  });
});
