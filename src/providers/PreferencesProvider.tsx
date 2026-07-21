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
import { toast } from "sonner";
import { useAgents } from "@/hooks/useAgents";
import { useConnectedProviders } from "@/hooks/useProviders";
import { setDetailedAnalyticsEnabled as setDetailedAnalyticsCollection } from "@/lib/analytics";
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

export const PreferencesContext = createContext<PreferencesContextValue>(null!);

export function usePreferences() {
  return useContext(PreferencesContext);
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
  const [detailedAnalyticsEnabled, setDetailedAnalyticsEnabledState] = useState(false);
  const detailedAnalyticsEnabledRef = useRef(false);

  const connectedProviders = useConnectedProviders();

  const setDetailedAnalyticsEnabled = useCallback((enabled: boolean) => {
    const previous = detailedAnalyticsEnabledRef.current;
    detailedAnalyticsEnabledRef.current = enabled;
    setDetailedAnalyticsEnabledState(enabled);
    setDetailedAnalyticsCollection(enabled);
    patchConfig({ detailedAnalytics: enabled ? "enabled" : "disabled" }).catch(() => {
      detailedAnalyticsEnabledRef.current = previous;
      setDetailedAnalyticsEnabledState(previous);
      setDetailedAnalyticsCollection(previous);
    });
  }, []);

  // Initialize from config data when it arrives and prompt once when no choice exists.
  useEffect(() => {
    if (!configData) return;
    setHiddenModels(new Set(configData.hiddenModels));
    const detailedEnabled = configData.detailedAnalytics === "enabled";
    detailedAnalyticsEnabledRef.current = detailedEnabled;
    setDetailedAnalyticsEnabledState(detailedEnabled);
    setDetailedAnalyticsCollection(detailedEnabled);

    if (configData.detailedAnalytics === "unset") {
      toast("Help improve BloxBot", {
        id: "detailed-analytics-consent",
        description:
          "Share provider, model, and aggregate token usage. Prompts, responses, files, and agent names are never collected.",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Share usage",
          onClick: () => setDetailedAnalyticsEnabled(true),
        },
        cancel: {
          label: "Not now",
          onClick: () => setDetailedAnalyticsEnabled(false),
        },
      });
    }
  }, [configData, setDetailedAnalyticsEnabled]);

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

  const value: PreferencesContextValue = {
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
  };

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
