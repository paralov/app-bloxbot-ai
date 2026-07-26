import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { updateStudioAssignment } from "@/hooks/useStudioAssignments";
import { qk } from "@/lib/queryKeys";
import type { AppConfig } from "@/types/desktop";

const mocks = vi.hoisted(() => ({ loadConfig: vi.fn(), patchConfig: vi.fn() }));
vi.mock("@/lib/config", () => mocks);
vi.mock("@/providers/OpenCodeClientProvider", () => ({
  useOpenCodeClient: () => ({ client: null }),
}));

const stored: AppConfig = {
  lastModel: "openai/gpt-5",
  hiddenModels: ["openai/hidden"],
  theme: "dark",
  detailedAnalytics: "enabled",
  studioAssignments: {},
};

describe("updateStudioAssignment", () => {
  beforeEach(() => {
    mocks.loadConfig.mockResolvedValue(stored);
    mocks.patchConfig.mockResolvedValue(undefined);
  });

  it("loads existing preferences before saving an assignment", async () => {
    const queryClient = new QueryClient();
    await updateStudioAssignment(queryClient, "s1", { id: "studio-1", name: "Lobby" });
    expect(queryClient.getQueryData(qk.config)).toEqual({
      ...stored,
      studioAssignments: { s1: { id: "studio-1", name: "Lobby" } },
    });
  });

  it("restores the cached config when saving fails", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.config, stored);
    mocks.patchConfig.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      updateStudioAssignment(queryClient, "s1", { id: "studio-1", name: "Lobby" }),
    ).rejects.toThrow("disk full");
    expect(queryClient.getQueryData(qk.config)).toEqual(stored);
  });
});
