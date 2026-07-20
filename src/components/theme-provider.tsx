import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { loadConfig, patchConfig } from "@/lib/config";
import { qk } from "@/lib/queryKeys";
import type { ThemePreference } from "@/types/desktop";

export type Theme = ThemePreference;
export type ResolvedTheme = "light" | "dark";

export const THEME_OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: Theme;
};

type ThemeProviderState = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? getSystemTheme() : theme;
}

function applyTheme(theme: Theme): ResolvedTheme {
  const root = window.document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  return resolved;
}

function subscribePrefersColorScheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }

  const media = window.matchMedia("(prefers-color-scheme: dark)");

  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }

  media.addListener(onChange);
  return () => media.removeListener(onChange);
}

export function ThemeProvider({ children, defaultTheme = "system" }: ThemeProviderProps) {
  const { data: configData } = useQuery({
    queryKey: qk.config,
    queryFn: loadConfig,
  });

  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(defaultTheme),
  );

  useEffect(() => {
    if (!configData) return;
    setThemeState(configData.theme);
  }, [configData]);

  useEffect(() => {
    const sync = () => setResolvedTheme(applyTheme(theme));
    sync();

    if (theme !== "system") return;
    return subscribePrefersColorScheme(sync);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    setResolvedTheme(applyTheme(next));
    patchConfig({ theme: next }).catch(() => {});
  }, []);

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeProviderContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
