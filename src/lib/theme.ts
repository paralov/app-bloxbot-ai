import type { ThemePreference } from "@/types/desktop";

export type { ThemePreference };
export type ResolvedTheme = "light" | "dark";

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function prefersDarkScheme(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(theme: ThemePreference): ResolvedTheme {
  if (theme === "system") {
    return prefersDarkScheme() ? "dark" : "light";
  }
  return theme;
}

export function applyThemeClass(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/** Subscribe to OS color-scheme changes with legacy MediaQueryList fallbacks. */
export function subscribePrefersColorScheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const media = window.matchMedia("(prefers-color-scheme: dark)");

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }

  // Legacy Safari / older Electron: MediaQueryList only exposes addListener/removeListener.
  media.addListener(onChange);
  return () => media.removeListener(onChange);
}
