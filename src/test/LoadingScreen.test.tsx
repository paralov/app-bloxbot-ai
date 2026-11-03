import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import LoadingScreen from "@/components/LoadingScreen";
import { getStartupErrorPresentation } from "@/providers/OpenCodeClientProvider";

describe("startup progress", () => {
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

  const installFailure = (reason: string) =>
    "Error: Failed to get OpenCode connection details: Error invoking remote method 'opencode:get-info': " +
    "Unable to download a verified OpenCode 1.x.x release and no cached copy is available. " +
    `Release check: GitHub release lookup failed with HTTP 403. Pinned v1.18.33: Failed to extract the OpenCode archive (reason: ${reason})`;

  it("tells people to allow BloxBot in their antivirus and shows the folder to exclude", () => {
    const folder = "C:\\Users\\example\\AppData\\Roaming\\BloxBot\\opencode";
    const technicalDetail = installFailure("blocked_by_security");
    const presentation = getStartupErrorPresentation(technicalDetail, folder);

    render(<LoadingScreen {...presentation} error onRetry={() => {}} />);

    expect(screen.getByRole("heading", { name: "Setup couldn't finish" })).toBeVisible();
    expect(
      screen.getByText(
        "Windows security software blocked OpenCode, the engine BloxBot runs on. Allow BloxBot in your antivirus, or add its folder as an exclusion, then retry.",
      ),
    ).toBeVisible();
    expect(screen.getByText(folder)).toBeVisible();
    expect(screen.getByText("Technical details")).toBeVisible();
    expect(screen.getByText(technicalDetail)).toBeInTheDocument();
  });

  it("tells people how much space to free when the drive is full", () => {
    const technicalDetail = installFailure("disk_full");
    const presentation = getStartupErrorPresentation(technicalDetail, "C:\\ignored");

    render(<LoadingScreen {...presentation} error onRetry={() => {}} />);

    expect(
      screen.getByText("Your drive is nearly full. Free up at least 500 MB, then retry."),
    ).toBeVisible();
    expect(screen.queryByText("C:\\ignored")).not.toBeInTheDocument();
    expect(screen.getByText(technicalDetail)).toBeInTheDocument();
  });

  it("keeps the download copy for network failures", () => {
    expect(getStartupErrorPresentation(installFailure("network"))).toMatchObject({
      message: "Setup couldn't finish",
      detail:
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then restart setup.",
    });
  });

  it("doesn't blame the network for other install failures", () => {
    const technicalDetail = installFailure("other");
    const presentation = getStartupErrorPresentation(technicalDetail);

    render(<LoadingScreen {...presentation} error onRetry={() => {}} />);

    expect(
      screen.getByText(
        "BloxBot couldn't set up OpenCode, the engine it runs on. Restart setup, and if it keeps failing, copy the technical details and send them to us.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/internet connection/)).not.toBeInTheDocument();
    expect(screen.getByText(technicalDetail)).toBeInTheDocument();
  });
});
