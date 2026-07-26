import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { staleStudioAssignmentIDs, updateStudioAssignment } from "@/hooks/useStudioAssignments";
import { qk } from "@/lib/queryKeys";
import type { AppConfig } from "@/types/desktop";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  patchConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/config", () => ({
  loadConfig: mocks.loadConfig,
  patchConfig: mocks.patchConfig,
}));

vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: null }),
}));

const storedConfig: AppConfig = {
  lastModel: "openai/gpt-5",
  hiddenModels: ["openai/hidden"],
  theme: "dark",
  detailedAnalytics: "enabled",
  studioAssignments: {},
};

describe("updateStudioAssignment", () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset().mockResolvedValue(storedConfig);
    mocks.patchConfig.mockClear();
  });

  it("loads existing preferences before updating an empty config cache", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await updateStudioAssignment(queryClient, "s1", { id: "studio-1", name: "Lobby" });

    expect(queryClient.getQueryData(qk.config)).toEqual({
      ...storedConfig,
      studioAssignments: { s1: { id: "studio-1", name: "Lobby" } },
    });
    expect(mocks.patchConfig).toHaveBeenCalledWith({
      studioAssignments: { s1: { id: "studio-1", name: "Lobby" } },
    });
  });

  it("rolls back only the failed session assignment", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<AppConfig>(qk.config, {
      ...storedConfig,
      studioAssignments: { s1: { id: "old", name: "Old" } },
    });
    mocks.patchConfig.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      updateStudioAssignment(queryClient, "s1", { id: "new", name: "New" }),
    ).rejects.toThrow("disk full");

    expect(queryClient.getQueryData<AppConfig>(qk.config)?.studioAssignments).toEqual({
      s1: { id: "old", name: "Old" },
    });
  });

  it("serializes assignment writes so concurrent sessions are both persisted", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData<AppConfig>(qk.config, storedConfig);
    let releaseFirst: (() => void) | undefined;
    mocks.patchConfig
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const first = updateStudioAssignment(queryClient, "s1", { id: "one", name: "One" });
    const second = updateStudioAssignment(queryClient, "s2", { id: "two", name: "Two" });
    await vi.waitFor(() => expect(mocks.patchConfig).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(mocks.patchConfig).toHaveBeenNthCalledWith(2, {
      studioAssignments: {
        s1: { id: "one", name: "One" },
        s2: { id: "two", name: "Two" },
      },
    });
  });
});

describe("staleStudioAssignmentIDs", () => {
  it("finds assignments whose sessions no longer exist", () => {
    expect(
      staleStudioAssignmentIDs(
        {
          current: { id: "studio-1", name: "Lobby" },
          deleted: { id: "studio-2", name: "Arena" },
        },
        new Set(["current"]),
      ),
    ).toEqual(["deleted"]);
  });
});
