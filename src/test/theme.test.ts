import { afterEach, describe, expect, it, vi } from "vitest";

import { applyThemeClass, resolveTheme, subscribePrefersColorScheme } from "@/lib/theme";

describe("theme helpers", () => {
  afterEach(() => {
    document.documentElement.classList.remove("dark");
    vi.unstubAllGlobals();
  });

  it("resolves system theme from the OS preference", () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: query === "(prefers-color-scheme: dark)",
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );

    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("toggles the dark class on the document element", () => {
    applyThemeClass("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    applyThemeClass("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("falls back to light when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);

    expect(resolveTheme("system")).toBe("light");
  });

  it("subscribes with addEventListener when available", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      () =>
        ({
          matches: false,
          media: "(prefers-color-scheme: dark)",
          addEventListener,
          removeEventListener,
        }) as unknown as MediaQueryList,
    );

    const onChange = vi.fn();
    const unsubscribe = subscribePrefersColorScheme(onChange);
    expect(addEventListener).toHaveBeenCalledWith("change", onChange);

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith("change", onChange);
  });

  it("falls back to addListener on legacy MediaQueryList", () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      () =>
        ({
          matches: false,
          media: "(prefers-color-scheme: dark)",
          addListener,
          removeListener,
        }) as unknown as MediaQueryList,
    );

    const onChange = vi.fn();
    const unsubscribe = subscribePrefersColorScheme(onChange);
    expect(addListener).toHaveBeenCalledWith(onChange);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(onChange);
  });
});
