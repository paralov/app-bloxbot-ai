import { usePostHog } from "@posthog/react";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAgents } from "@/hooks/useAgents";
import { useConnectedProviders } from "@/hooks/useProviders";
import { disableAnalytics, enableAnalytics } from "@/lib/analytics";
import { type AppConfig, loadConfig, patchConfig } from "@/lib/config";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";

interface PreferencesContextValue {
  selectedModel: string | null;
  selectedAgent: string | null;
  selectedVariant: string | null;
  hiddenModels: Set<string>;
  analyticsEnabled: boolean;
  setSelectedModel: (modelID: string) => void;
  setSelectedAgent: (name: string) => void;
  setSelectedVariant: (variant: string | null) => void;
  toggleModelVisibility: (modelKey: string) => void;
  setAnalyticsEnabled: (enabled: boolean) => void;
}

export const PreferencesContext = createContext<PreferencesContextValue>(null!);

export function usePreferences() {
  return useContext(PreferencesContext);
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const posthog = usePostHog();
  const { data: configData } = useQuery<AppConfig>({
    queryKey: qk.config,
    queryFn: loadConfig,
  });

  const [selectedModel, setSelectedModelState] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgentState] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariantState] = useState<string | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(false);
  const appOpenedTrackedRef = useRef(false);

  const connectedProviders = useConnectedProviders();

  // Initialize from config data when it arrives
  useEffect(() => {
    if (!configData) return;
    setHiddenModels(new Set(configData.hiddenModels));
    setAnalyticsEnabledState(configData.analyticsEnabled);
  }, [configData]);

  useEffect(() => {
    if (!configData) return;
    if (!analyticsEnabled) {
      disableAnalytics(posthog);
      return;
    }
    const captureAppOpened = !appOpenedTrackedRef.current;
    appOpenedTrackedRef.current = true;
    void enableAnalytics(
      posthog,
      {
        production: import.meta.env.PROD,
        getVersion: () => desktop.getVersion(),
        platform: navigator.platform,
        runtime: window.bloxbot ? "electron" : "browser",
      },
      captureAppOpened,
    );
  }, [analyticsEnabled, configData, posthog]);

  // Restore last used model if its provider is still connected
  useEffect(() => {
    if (!configData || connectedProviders.length === 0) return;
    if (
      configData.lastModel &&
      connectedProviders.includes(splitModelKey(configData.lastModel)[0])
    ) {
      setSelectedModelState(configData.lastModel);
    }
  }, [configData, connectedProviders]);

  // Auto-select first agent
  const agents = useAgents();
  useEffect(() => {
    if (agents.length === 0 || selectedAgent) return;
    const primary = agents.find((a) => a.mode === "primary" && !a.hidden);
    if (primary) setSelectedAgentState(primary.name);
  }, [agents, selectedAgent]);

  const setSelectedModel = useCallback((modelID: string) => {
    setSelectedModelState(modelID);
    patchConfig({ lastModel: modelID }).catch(() => {});
  }, []);

  const setSelectedAgent = useCallback((name: string) => {
    setSelectedAgentState(name);
  }, []);

  const setSelectedVariant = useCallback((variant: string | null) => {
    setSelectedVariantState(variant);
  }, []);

  const toggleModelVisibility = useCallback((modelKey: string) => {
    setHiddenModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelKey)) {
        next.delete(modelKey);
      } else {
        next.add(modelKey);
      }
      patchConfig({ hiddenModels: [...next] }).catch(() => {});
      return next;
    });
  }, []);

  const setAnalyticsEnabled = useCallback((enabled: boolean) => {
    setAnalyticsEnabledState(enabled);
    patchConfig({ analyticsEnabled: enabled }).catch(() => {
      setAnalyticsEnabledState(!enabled);
    });
  }, []);

  const value: PreferencesContextValue = {
    selectedModel,
    selectedAgent,
    selectedVariant,
    hiddenModels,
    analyticsEnabled,
    setSelectedModel,
    setSelectedAgent,
    setSelectedVariant,
    toggleModelVisibility,
    setAnalyticsEnabled,
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
