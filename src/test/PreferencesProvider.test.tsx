import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ patchConfig: vi.fn(), loadConfig: vi.fn() }));

vi.mock("@/lib/config", () => ({
  loadConfig: mocks.loadConfig,
  patchConfig: mocks.patchConfig,
}));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: vi.fn(), register: vi.fn() },
}));
vi.mock("@/hooks/useProviders", () => ({ useConnectedProviders: () => [] }));

import { PreferencesProvider, usePreferences } from "@/providers/PreferencesProvider";
import { DEFAULT_APP_CONFIG } from "@/types/desktop";

describe("notification preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_APP_CONFIG,
      analyticsNoticeVersion: 99,
      detailedAnalytics: "enabled",
    });
  });

  it("doesn't let an older failed save undo a newer choice", async () => {
    let failFirst: (error: Error) => void = () => {};
    mocks.patchConfig.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    mocks.patchConfig.mockResolvedValue(undefined);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <PreferencesProvider>{children}</PreferencesProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => usePreferences(), { wrapper });
    await waitFor(() => expect(mocks.loadConfig).toHaveBeenCalled());
    await act(async () => {});

    act(() => result.current.setNotificationKind("finished", false));
    act(() => result.current.setNotificationKind("waiting", false));
    await act(async () => failFirst(new Error("disk busy")));

    expect(result.current.notifications.kinds).toMatchObject({ finished: false, waiting: false });
  });

  it("puts a choice back when its own save fails", async () => {
    mocks.patchConfig.mockRejectedValue(new Error("disk busy"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <PreferencesProvider>{children}</PreferencesProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => usePreferences(), { wrapper });
    await waitFor(() => expect(mocks.loadConfig).toHaveBeenCalled());
    await act(async () => {});

    await act(async () => result.current.setNotificationKind("finished", false));

    expect(result.current.notifications.kinds.finished).toBe(true);
  });
});
