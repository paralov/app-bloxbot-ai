import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { qk } from "@/lib/queryKeys";

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
}

function ThemeProbe() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        light
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        system
      </button>
    </div>
  );
}

function renderThemeProvider(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("light", "dark");
    window.localStorage.clear();
  });

  afterEach(() => {
    document.documentElement.classList.remove("light", "dark");
    vi.unstubAllGlobals();
  });

  it("applies the dark class and persists preference via AppConfig", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(qk.config, {
      lastModel: null,
      hiddenModels: [],
      theme: "system",
      detailedAnalytics: "disabled",
    });

    renderThemeProvider(queryClient);

    await act(async () => {
      screen.getByRole("button", { name: "dark" }).click();
    });

    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    const { desktop } = await import("@/lib/desktop");
    await waitFor(async () => {
      await expect(desktop.loadConfig()).resolves.toMatchObject({ theme: "dark" });
    });
  });

  it("hydrates from persisted AppConfig theme", async () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(qk.config, {
      lastModel: null,
      hiddenModels: [],
      theme: "dark",
      detailedAnalytics: "disabled",
    });

    renderThemeProvider(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId("theme")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });

  it("follows the OS preference when theme is system", async () => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.add(listener);
          },
          removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.delete(listener);
          },
        }) as unknown as MediaQueryList,
    );

    const queryClient = makeQueryClient();
    queryClient.setQueryData(qk.config, {
      lastModel: null,
      hiddenModels: [],
      theme: "system",
      detailedAnalytics: "disabled",
    });

    renderThemeProvider(queryClient);

    await waitFor(() => {
      expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    });

    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(prefers-color-scheme: dark)",
          media: query,
          addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.add(listener);
          },
          removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
            listeners.delete(listener);
          },
        }) as unknown as MediaQueryList,
    );

    await act(async () => {
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });
});
