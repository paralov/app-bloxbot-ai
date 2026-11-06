import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ patchConfig: vi.fn(), loadConfig: vi.fn() }));

vi.mock("@/lib/config", () => ({
  loadConfig: mocks.loadConfig,
  patchConfig: mocks.patchConfig,
}));
vi.mock("posthog-js/dist/module.full.no-external.js", () => ({
  default: { capture: vi.fn(), register: vi.fn() },
}));
const providers = vi.hoisted(() => ({
  list: undefined as unknown,
  connected: [] as string[],
}));
vi.mock("@/hooks/useProviders", () => ({
  useConnectedProviders: () => providers.connected,
  useProviderList: () => providers.list,
}));

import { notify } from "@/lib/notifications";
import { PreferencesProvider, usePreferences } from "@/providers/PreferencesProvider";
import { DEFAULT_APP_CONFIG } from "@/types/desktop";

function renderPreferences() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <PreferencesProvider>{children}</PreferencesProvider>
    </QueryClientProvider>
  );
  return renderHook(() => usePreferences(), { wrapper });
}

describe("the saved model", () => {
  const freeTier = {
    id: "opencode",
    name: "OpenCode Zen",
    source: "custom",
    models: {
      "flash-free": { id: "flash-free", name: "Flash Free", status: "active" },
      "crouton-alpha-free": { id: "crouton-alpha-free", name: "Crouton", status: "alpha" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.patchConfig.mockResolvedValue(undefined);
    providers.connected = ["opencode"];
    providers.list = {
      all: [freeTier],
      connected: ["opencode"],
      default: { opencode: "flash-free" },
    };
  });
  afterEach(() => {
    providers.connected = [];
    providers.list = undefined;
  });

  it("moves to the default model, and says so, when OpenCode no longer lists it", async () => {
    const message = vi.spyOn(notify, "message");
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_APP_CONFIG,
      analyticsNoticeVersion: 99,
      lastModel: "opencode/nemotron-3-ultra-free",
    });
    const { result } = renderPreferences();

    await waitFor(() => expect(result.current.selectedModel).toBe("opencode/flash-free"));
    expect(mocks.patchConfig).toHaveBeenCalledWith({ lastModel: "opencode/flash-free" });
    expect(message).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledWith("nemotron-3-ultra-free is no longer available", {
      description: "This chat now uses Flash Free.",
    });
  });

  it("doesn't bring back a model refused in the user's region", async () => {
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_APP_CONFIG,
      analyticsNoticeVersion: 99,
      lastModel: "opencode/crouton-alpha-free",
      unavailableModels: ["opencode/crouton-alpha-free"],
    });
    const { result } = renderPreferences();

    await waitFor(() => expect(result.current.selectedModel).toBe("opencode/flash-free"));
    expect(result.current.unavailableModels.has("opencode/crouton-alpha-free")).toBe(true);
  });

  it("keeps a listed model, and remembers one refused in the region once", async () => {
    const message = vi.spyOn(notify, "message");
    mocks.loadConfig.mockResolvedValue({
      ...DEFAULT_APP_CONFIG,
      analyticsNoticeVersion: 99,
      lastModel: "opencode/crouton-alpha-free",
    });
    const { result } = renderPreferences();
    await waitFor(() => expect(result.current.selectedModel).toBe("opencode/crouton-alpha-free"));

    act(() => result.current.markModelUnavailable("opencode/crouton-alpha-free"));
    act(() => result.current.markModelUnavailable("opencode/crouton-alpha-free"));

    expect(result.current.unavailableModels.has("opencode/crouton-alpha-free")).toBe(true);
    const saves = mocks.patchConfig.mock.calls.filter(([patch]) => "unavailableModels" in patch);
    expect(saves).toEqual([[{ unavailableModels: ["opencode/crouton-alpha-free"] }]]);
    // Its card offers the switch, so the chat isn't moved out from under it.
    expect(result.current.selectedModel).toBe("opencode/crouton-alpha-free");
    expect(message).not.toHaveBeenCalled();
  });
});

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
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <PreferencesProvider>{children}</PreferencesProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => usePreferences(), { wrapper });
    // Choices are only meaningful once what was saved has loaded, which replaces the defaults.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(mocks.loadConfig).toHaveBeenCalled());
    await act(async () => {});

    act(() => result.current.setNotificationKind("finished", false));
    act(() => result.current.setNotificationKind("waiting", false));
    await act(async () => failFirst(new Error("disk busy")));

    expect(result.current.notifications.kinds).toMatchObject({ finished: false, waiting: false });
  });

  it("puts a choice back when its own save fails", async () => {
    mocks.patchConfig.mockRejectedValue(new Error("disk busy"));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <PreferencesProvider>{children}</PreferencesProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => usePreferences(), { wrapper });
    // Choices are only meaningful once what was saved has loaded, which replaces the defaults.
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(mocks.loadConfig).toHaveBeenCalled());
    await act(async () => {});

    await act(async () => result.current.setNotificationKind("finished", false));

    expect(result.current.notifications.kinds.finished).toBe(true);
  });
});
