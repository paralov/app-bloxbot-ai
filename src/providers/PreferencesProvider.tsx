import { useQuery } from "@tanstack/react-query";
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
import { useConnectedProviders } from "@/hooks/useProviders";
import {
  ANALYTICS_NOTICE_VERSION,
  setDetailedAnalyticsEnabled as setDetailedAnalyticsCollection,
} from "@/lib/analytics";
import { type AppConfig, loadConfig, patchConfig } from "@/lib/config";
import { notify, setSystemNotificationsAllowed } from "@/lib/notifications";
import { qk } from "@/lib/queryKeys";
import { splitModelKey } from "@/lib/splitModelKey";

interface PreferencesContextValue {
  selectedModel: string | null;
  selectedVariant: string | null;
  hiddenModels: Set<string>;
  detailedAnalyticsEnabled: boolean;
  setSelectedModel: (modelID: string) => void;
  setSelectedVariant: (variant: string | null) => void;
  toggleModelVisibility: (modelKey: string) => void;
  setDetailedAnalyticsEnabled: (enabled: boolean) => void;
  systemNotificationsEnabled: boolean;
  setSystemNotificationsEnabled: (enabled: boolean) => void;
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
  const [selectedVariant, setSelectedVariantState] = useState<string | null>(null);
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(new Set());
  const [detailedAnalyticsEnabled, setDetailedAnalyticsEnabledState] = useState(false);
  const detailedAnalyticsEnabledRef = useRef(false);

  const [systemNotificationsEnabled, setSystemNotificationsEnabledState] = useState(true);

  const connectedProviders = useConnectedProviders();

  const setSystemNotificationsEnabled = useCallback((enabled: boolean) => {
    setSystemNotificationsEnabledState(enabled);
    setSystemNotificationsAllowed(enabled);
    patchConfig({ systemNotifications: enabled }).catch(() => {
      setSystemNotificationsEnabledState(!enabled);
      setSystemNotificationsAllowed(!enabled);
    });
  }, []);

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

  // Initialize from config data when it arrives and notify once about opt-out metrics.
  useEffect(() => {
    if (!configData) return;
    setHiddenModels(new Set(configData.hiddenModels));
    setSystemNotificationsEnabledState(configData.systemNotifications);
    setSystemNotificationsAllowed(configData.systemNotifications);

    // Model usage metrics moved from opt-in to opt-out in notice version 1. Choices
    // recorded under the old consent prompt (including clickaways) do not carry
    // over; opt-outs made since then do and skip the notice, since nothing is sent.
    // The notice stays short; Settings → Privacy lists everything that is shared.
    if (configData.analyticsNoticeVersion < ANALYTICS_NOTICE_VERSION) {
      const enabled =
        configData.analyticsNoticeVersion < 1 || configData.detailedAnalytics !== "disabled";
      detailedAnalyticsEnabledRef.current = enabled;
      setDetailedAnalyticsEnabledState(enabled);
      setDetailedAnalyticsCollection(enabled);
      if (enabled) {
        notify.message("BloxBot shares AI usage data", {
          name: "analytics_notice",
          id: "analytics-optout-notice",
          className: "card-toast",
          description:
            "Your chats and tool activity help improve BloxBot. Details in Settings → Privacy.",
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: "Got it",
            onClick: () => {},
          },
          cancel: {
            label: "Disable",
            onClick: () => setDetailedAnalyticsEnabled(false),
          },
        });
      }
      // Persist only after the notice is on screen, so a failure to show it
      // leaves the version behind and the notice fires again next launch.
      patchConfig({
        detailedAnalytics: enabled ? "enabled" : "disabled",
        analyticsNoticeVersion: ANALYTICS_NOTICE_VERSION,
      }).catch(() => {});
      return;
    }

    const detailedEnabled = configData.detailedAnalytics !== "disabled";
    detailedAnalyticsEnabledRef.current = detailedEnabled;
    setDetailedAnalyticsEnabledState(detailedEnabled);
    setDetailedAnalyticsCollection(detailedEnabled);
  }, [configData, setDetailedAnalyticsEnabled]);

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

  const setSelectedModel = useCallback((modelID: string) => {
    setSelectedModelState(modelID);
    patchConfig({ lastModel: modelID }).catch(() => {});
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
      selectedVariant,
      hiddenModels,
      detailedAnalyticsEnabled,
      systemNotificationsEnabled,
      setSelectedModel,
      setSelectedVariant,
      toggleModelVisibility,
      setDetailedAnalyticsEnabled,
      setSystemNotificationsEnabled,
    }),
    [
      selectedModel,
      selectedVariant,
      hiddenModels,
      detailedAnalyticsEnabled,
      systemNotificationsEnabled,
      setSelectedModel,
      setSelectedVariant,
      toggleModelVisibility,
      setDetailedAnalyticsEnabled,
      setSystemNotificationsEnabled,
    ],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
