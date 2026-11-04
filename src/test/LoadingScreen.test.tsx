import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkForUpdate, installUpdate } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock("@/lib/desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/desktop")>()),
  desktop: { checkForUpdate, installUpdate },
}));

import LoadingScreen from "@/components/LoadingScreen";
import {
  getStartupErrorPresentation,
  getStartupPresentation,
} from "@/providers/OpenCodeClientProvider";

describe("startup progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkForUpdate.mockResolvedValue(null);
  });

  it("offers an update straight away when one could get someone unstuck", async () => {
    checkForUpdate.mockResolvedValue({ version: "9.9.9", body: null });

    render(<LoadingScreen message="BloxBot couldn't start" error onRetry={() => {}} />);

    const install = await screen.findByRole("button", { name: "Install v9.9.9 & restart" });
    expect(install).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check for updates" })).not.toBeInTheDocument();

    fireEvent.click(install);
    expect(installUpdate).toHaveBeenCalledOnce();
    // The same button, so keyboard focus stays on it while it works.
    expect(install).toHaveAttribute("aria-busy", "true");
    expect(await screen.findByRole("status")).toHaveTextContent("Installing the update");
  });

  it("names what to do when the engine stops right away", () => {
    for (const failure of [
      "Failed to spawn OpenCode",
      "OpenCode exited during startup with code 1",
      "OpenCode stopped unexpectedly with code 1",
    ]) {
      const presentation = getStartupErrorPresentation(failure, "C:\\BloxBot");
      expect(presentation.message).toBe("BloxBot couldn't start");
      expect(presentation.detailPath).toBe("C:\\BloxBot");
    }
  });

  it("offers a way out once a step has gone quiet", () => {
    const onRetry = vi.fn();
    render(
      <LoadingScreen
        message="Starting your workspace"
        startup={{ step: 1, label: "Preparing", progress: 1 }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Restarting..." })).toBeDisabled();
  });

  it("fills in a report with what happened, for checking before sending", () => {
    render(
      <LoadingScreen
        message="BloxBot couldn't start"
        technicalDetail="OpenCode did not become healthy"
        error
        onRetry={() => {}}
      />,
    );
    const href =
      screen.getByRole("link", { name: "Email support@bloxbot.ai" }).getAttribute("href") ?? "";
    expect(href).toMatch(/^mailto:support@bloxbot\.ai/);
    expect(decodeURIComponent(href)).toContain("OpenCode did not become healthy");
  });

  it("says out loud when an update check fails, and how far a download has got", async () => {
    checkForUpdate.mockRejectedValue(new Error("offline"));
    const { unmount } = render(<LoadingScreen message="Couldn't start" error onRetry={() => {}} />);
    // The check it does by itself failing isn't something anyone asked about.
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    await expect(screen.findByText("Couldn't check for updates")).resolves.toBeInTheDocument();
    unmount();

    render(
      <LoadingScreen
        message="Downloading"
        startup={{ step: 1, label: "Preparing", progress: 0.6 }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Downloaded 50%");
  });

  it("says out loud when it finds an update", async () => {
    checkForUpdate.mockResolvedValue({ version: "9.9.9", body: null });
    render(<LoadingScreen message="BloxBot couldn't start" error onRetry={() => {}} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Update available: v9.9.9");
  });

  it("shows Try again was heard", () => {
    const onRetry = vi.fn();
    render(<LoadingScreen message="BloxBot couldn't start" error onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Restarting..." })).toBeDisabled();
  });

  it("gives the folder to exclude a copy button, and a how-to on Windows", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0)");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const presentation = getStartupErrorPresentation(
      "Install failed (reason: blocked_by_security)",
      "C:\\BloxBot",
    );
    render(<LoadingScreen {...presentation} error onRetry={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy folder" }));
    expect(writeText).toHaveBeenCalledWith("C:\\BloxBot");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
    expect(
      screen.getByRole("link", { name: "How to add an exclusion in Windows Security" }),
    ).toHaveAttribute("href", expect.stringContaining("support.microsoft.com"));
    vi.restoreAllMocks();
    expect(
      getStartupErrorPresentation("Install failed (reason: blocked_by_security)").helpLink,
    ).toBeUndefined();
  });

  it("says when copying the folder didn't work", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(
      <LoadingScreen
        message="BloxBot couldn't start"
        detailPath="C:\\BloxBot"
        error
        onRetry={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy folder" }));
    expect(await screen.findByRole("button", { name: "Couldn't copy" })).toBeVisible();
  });

  it("doesn't look for updates while everything is fine", () => {
    render(<LoadingScreen message="Starting up..." />);
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it("points at what to do when the engine starts but can't be reached", () => {
    for (const failure of [
      "OpenCode did not open a listening port within 60 seconds. No port in its output",
      "OpenCode did not become healthy on port 51078 within 60 seconds. Last check: ECONNREFUSED",
    ]) {
      expect(getStartupErrorPresentation(failure)).toMatchObject({
        message: "BloxBot couldn't start",
        detail: expect.stringContaining("Allow this folder in your antivirus or pause your VPN"),
      });
    }
  });

  it("tells a stalled download apart from a blocked one", () => {
    const failure = (reason: string) =>
      `Unable to download a verified OpenCode 2.2.x release and no cached copy is available. Release check: ${reason}`;

    expect(
      getStartupErrorPresentation(
        failure("OpenCode download failed: stalled, no data for 60 seconds (12.0 MB received)"),
      ).detail,
    ).toBe("The download stopped getting data. Check your connection, then try again.");
    expect(
      getStartupErrorPresentation(
        failure(
          "GitHub release lookup failed: fetch failed (unable to verify the first certificate)",
        ),
      ).detail,
    ).toContain("A company network or antivirus blocked the download");
  });

  it("tells a failed install apart from a failed check, and offers it again", async () => {
    checkForUpdate.mockResolvedValue({ version: "9.9.9", body: null });
    installUpdate.mockRejectedValueOnce(new Error("no"));
    render(<LoadingScreen message="BloxBot couldn't start" error onRetry={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install v9.9.9 & restart" }));
    expect(await screen.findByRole("button", { name: "Retry the update" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't install the update");
  });

  it("explains a step that has gone quiet instead of looking frozen", () => {
    const downloading = {
      phase: "downloading",
      downloadedBytes: 512,
      totalBytes: 1024,
      bytesPerSecond: 2048,
    } as const;

    const moving = getStartupPresentation("engine", downloading);
    expect(moving.detail).toBe("It's kept for next time");
    expect(moving.startup.meta).toBe("50% 2.0 KB/s");

    const quiet = getStartupPresentation("engine", downloading, true);
    expect(quiet.detail).toBe(
      "Connection paused. Check your Wi-Fi or security software. BloxBot keeps trying.",
    );
    expect(quiet.startup.meta).toBe("50%");
    // With no total to measure against there's no percentage, and the old speed is no use.
    expect(
      getStartupPresentation("engine", { ...downloading, totalBytes: null }, true).startup.meta,
    ).toBeUndefined();

    expect(getStartupPresentation("engine", { phase: "installing" }, true).detail).toContain(
      "Security software",
    );
    expect(getStartupPresentation("engine", { phase: "starting" }, true).detail).toContain(
      "Security software",
    );
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
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();

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
        "Security software blocked BloxBot's engine. Add this folder as an exclusion, then try again.",
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
      screen.getByText("Your drive is nearly full. Free up at least 500 MB, then try again."),
    ).toBeVisible();
    expect(screen.queryByText("C:\\ignored")).not.toBeInTheDocument();
    expect(screen.getByText(technicalDetail)).toBeInTheDocument();
  });

  it("keeps the download copy for network failures", () => {
    expect(getStartupErrorPresentation(installFailure("network"))).toMatchObject({
      message: "Setup couldn't finish",
      detail:
        "BloxBot couldn't download its setup files. Check your internet connection, VPN, or firewall, then try again.",
    });
  });

  it("doesn't blame the network for other install failures", () => {
    const technicalDetail = installFailure("other");
    const presentation = getStartupErrorPresentation(technicalDetail);

    render(<LoadingScreen {...presentation} error onRetry={() => {}} />);

    expect(
      screen.getByText(
        "BloxBot couldn't set up its engine. Try again, or email support if it keeps failing.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/internet connection/)).not.toBeInTheDocument();
    expect(screen.getByText(technicalDetail)).toBeInTheDocument();
  });
});
