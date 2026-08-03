import { useQuery } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgents } from "@/hooks/useAgents";
import { useConnectedProviders } from "@/hooks/useProviders";
import {
  analyticsProperties,
  setDetailedAnalyticsEnabled as setDetailedAnalyticsCollection,
} from "@/lib/analytics";
import { type AppConfig, loadConfig, patchConfig } from "@/lib/config";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";

interface PreferencesContextValue {
  selectedModel: string | null;
  selectedAgent: string | null;
  selectedVariant: string | null;
  hiddenModels: Set<string>;
  detailedAnalyticsEnabled: boolean;
  setSelectedModel: (modelID: string) => void;
  setSelectedAgent: (name: string) => void;
  setSelectedVariant: (variant: string | null) => void;
  toggleModelVisibility: (modelKey: string) => void;
  setDetailedAnalyticsEnabled: (enabled: boolean) => void;
}

export const PreferencesContext = createContext<PreferencesContextValue | undefined>(undefined);

export function usePreferences() {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error("usePreferences must be used within a PreferencesProvider");
  return context;
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { data: configData } = useQuery<AppConfig>({
    queryKey: qk.config,
    queryFn: loadConfig,
  });

  const [selectedModel, setSelectedModelState] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgentState] = useState<string | null>(null);
  const [selectedVariant, setSelectedVariantState] = useState<string | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [detailedAnalyticsEnabled, setDetailedAnalyticsEnabledState] = useState(true);
  const detailedAnalyticsEnabledRef = useRef(true);

  const connectedProviders = useConnectedProviders();

  const setDetailedAnalyticsEnabled = useCallback((enabled: boolean) => {
    const previous = detailedAnalyticsEnabledRef.current;
    // Capture the preference change before toggling (ensures the opt-out
    // event itself is still recorded with detailed analytics active).
    posthog.capture(
      "analytics_preference_changed",
      analyticsProperties("app", { detailed_analytics_enabled: enabled }),
    );
    detailedAnalyticsEnabledRef.current = enabled;
    setDetailedAnalyticsEnabledState(enabled);
    setDetailedAnalyticsCollection(enabled);
    patchConfig({ detailedAnalytics: enabled ? "enabled" : "disabled" }).catch(() => {
      detailedAnalyticsEnabledRef.current = previous;
      setDetailedAnalyticsEnabledState(previous);
      setDetailedAnalyticsCollection(previous);
    });
  }, []);

  // Initialize from config data when it arrives. Detailed analytics are on by
  // default ("unset" and "enabled" both resolve to true); only an explicit
  // "disabled" preference turns them off.
  useEffect(() => {
    if (!configData) return;
    setHiddenModels(new Set(configData.hiddenModels));
    const detailedEnabled = configData.detailedAnalytics !== "disabled";
    detailedAnalyticsEnabledRef.current = detailedEnabled;
    setDetailedAnalyticsEnabledState(detailedEnabled);
    setDetailedAnalyticsCollection(detailedEnabled);
  }, [configData]);

  // Restore a valid last-used model and clear selections whose provider disconnected.
  useEffect(() => {
    if (!configData) return;
    if (selectedModel && !connectedProviders.includes(splitModelKey(selectedModel)[0])) {
      setSelectedModelState(null);
      setSelectedVariantState(null);
      return;
    }
    if (
      !selectedModel &&
      configData.lastModel &&
      connectedProviders.includes(splitModelKey(configData.lastModel)[0])
    ) {
      setSelectedModelState(configData.lastModel);
    }
  }, [configData, connectedProviders, selectedModel]);

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

  const toggleModelVisibility = useCallback(
    (modelKey: string) => {
      const next = new Set(hiddenModels);
      if (next.has(modelKey)) {
        next.delete(modelKey);
      } else {
        next.add(modelKey);
      }
      setHiddenModels(next);
      patchConfig({ hiddenModels: [...next] }).catch(() => {});
    },
    [hiddenModels],
  );

  const value = useMemo<PreferencesContextValue>(
    () => ({
      selectedModel,
      selectedAgent,
      selectedVariant,
      hiddenModels,
      detailedAnalyticsEnabled,
      setSelectedModel,
      setSelectedAgent,
      setSelectedVariant,
      toggleModelVisibility,
      setDetailedAnalyticsEnabled,
    }),
    [
      selectedModel,
      selectedAgent,
      selectedVariant,
      hiddenModels,
      detailedAnalyticsEnabled,
      setSelectedModel,
      setSelectedAgent,
      setSelectedVariant,
      toggleModelVisibility,
      setDetailedAnalyticsEnabled,
    ],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
