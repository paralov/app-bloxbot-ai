import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoadingScreen from "@/components/LoadingScreen";
import {
  getStartupErrorPresentation,
  getStartupPresentation,
  type StartupPhase,
} from "@/providers/OpenCodeClientProvider";

describe("startup progress", () => {
  it.each([
    ["engine", "Getting things ready", "Preparing", 1],
    ["connection", "Connecting the dots", "Connecting", 2],
    ["workspace", "Setting the stage", "Opening", 3],
  ] as const)("gives the %s phase friendly copy and a visible step", (phase: StartupPhase, message, label, step) => {
    expect(getStartupPresentation(phase)).toMatchObject({
      message,
      startup: { label, step },
    });
  });

  it("shows a calm three-step progress treatment", () => {
    const startup = getStartupPresentation("connection");
    const { container } = render(<LoadingScreen {...startup} />);

    expect(screen.getByRole("heading", { name: "Connecting the dots" })).toBeVisible();
    expect(screen.getByText("Making sure everything can talk")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Connecting, step 2 of 3" })).toBeVisible();
    expect(screen.getByText("Step 2 of 3 · Connecting")).toBeVisible();
    expect(container.querySelector(".startup-progress-indeterminate")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenCode/i)).not.toBeInTheDocument();
  });

  it("shows real download percentage and transfer speed", () => {
    const startup = getStartupPresentation("engine", {
      phase: "downloading",
      downloadedBytes: 25,
      totalBytes: 100,
      bytesPerSecond: 2 * 1024 ** 2,
    });
    render(<LoadingScreen {...startup} />);

    expect(screen.getByRole("heading", { name: "Downloading a one-time setup" })).toBeVisible();
    expect(screen.getByText("Future launches will use the saved copy")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25% · 2.0 MB/s")).toBeVisible();
  });

  it("turns a verbose download failure into calm, actionable copy", () => {
    const technicalDetail =
      "Unable to download a verified OpenCode 1.x.x release and no cached copy is available: GitHub release lookup failed with HTTP 403 at file:///C:/Users/example/main.js";
    const presentation = getStartupErrorPresentation(technicalDetail);

    render(
      <LoadingScreen
        message={presentation.message}
        detail={presentation.detail}
        technicalDetail={presentation.technicalDetail}
        error
        onRetry={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Setup couldn't finish" })).toBeVisible();
    expect(
      screen.getByText(
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then restart setup.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Restart setup" })).toBeVisible();

    const disclosure = screen.getByText("Technical details");
    expect(screen.getByText(technicalDetail)).not.toBeVisible();
    fireEvent.click(disclosure);
    expect(screen.getByText(technicalDetail)).toBeVisible();
  });
});
