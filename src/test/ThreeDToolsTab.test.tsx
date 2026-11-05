import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  remove: vi.fn(),
  dispose: vi.fn(),
  listener: null as ((progress: unknown) => void) | null,
}));

vi.mock("@/lib/desktop", () => ({
  desktop: {
    getBlenderToolsState: mocks.getState,
    installBlenderTools: mocks.install,
    cancelBlenderTools: mocks.cancel,
    openBlender: mocks.open,
    removeBlenderTools: mocks.remove,
    getUploadAccess: async () => ({
      state: "no_studio",
      readOn: false,
      writeOn: false,
      folder: "/home/BloxBot/Models",
      folderUrl: "file:///home/BloxBot/Models",
    }),
    onBlenderSetupProgress: (listener: (progress: unknown) => void) => {
      mocks.listener = listener;
      return () => {};
    },
  },
}));
vi.mock("@/providers/StudioTargetProvider", () => ({
  useStudioTargetOptional: () => null,
}));
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: { instance: { dispose: mocks.dispose } } }),
}));

import { ThreeDToolsTab } from "@/components/ThreeDToolsTab";

const start = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ThreeDToolsTab />
    </QueryClientProvider>,
  );

describe("ThreeDToolsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.install.mockResolvedValue(undefined);
    mocks.dispose.mockResolvedValue(true);
  });

  it("says what Blender costs in space and risk before anyone commits", async () => {
    mocks.getState.mockResolvedValue({ state: "not_installed" });
    start();

    expect(await screen.findByRole("button", { name: "Set up Blender" })).toBeVisible();
    expect(screen.getByText(/1\.1 GB once installed/)).toBeVisible();
    expect(screen.getByText(/runs code the AI writes/)).toBeVisible();
    expect(screen.getByText(/BloxBot earns nothing/)).toBeVisible();
  });

  it("shows how far setup has got, and has OpenCode pick it up", async () => {
    mocks.getState.mockResolvedValue({ state: "not_installed" });
    let finish = () => {};
    mocks.install.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Blender" }));
    await screen.findByRole("button", { name: "Stop" });

    mocks.listener?.({ step: "downloading", downloadedBytes: 40, totalBytes: 100 });
    expect(await screen.findByText("Downloading 40%")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");

    finish();
    await waitFor(() => expect(mocks.dispose).toHaveBeenCalledOnce());
  });

  it("explains a failure and offers another go", async () => {
    mocks.getState.mockResolvedValue({ state: "not_installed" });
    mocks.install.mockRejectedValue(new Error("This needs about 2 GB free (reason: disk_full)"));
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Blender" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your drive is nearly full");
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("doesn't call stopping a failure", async () => {
    mocks.getState.mockResolvedValue({ state: "not_installed" });
    let fail = (_error: Error) => {};
    mocks.install.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Set up Blender" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(mocks.cancel).toHaveBeenCalledOnce();

    fail(new Error("Setup was stopped (reason: other)"));

    expect(await screen.findByRole("button", { name: "Set up Blender" })).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens Blender", async () => {
    mocks.getState.mockResolvedValue({ state: "ready", running: false });
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Open Blender" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledOnce());
  });

  it("says when Blender is connected", async () => {
    mocks.getState.mockResolvedValue({ state: "ready", running: true });
    start();

    expect(await screen.findByText("Open")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open Blender" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText(/Close Blender to remove it/)).toBeVisible();
  });

  it("removes it and has OpenCode forget it", async () => {
    mocks.getState.mockResolvedValue({ state: "ready", running: false });
    mocks.remove.mockResolvedValue(undefined);
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mocks.dispose).toHaveBeenCalledOnce());
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("reloads OpenCode and tries again when Windows holds the server's files", async () => {
    mocks.getState.mockResolvedValue({ state: "ready", running: false });
    mocks.remove.mockRejectedValueOnce(new Error("EBUSY")).mockResolvedValue(undefined);
    start();
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    expect(mocks.dispose).toHaveBeenCalled();
  });

  it("doesn't offer it where it can't run", async () => {
    mocks.getState.mockResolvedValue({ state: "unsupported" });
    start();

    expect(await screen.findByText("Not available on this computer.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Set up Blender" })).toBeNull();
  });
});
