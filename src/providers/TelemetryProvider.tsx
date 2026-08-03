import { useQuery } from "@tanstack/react-query";
import posthog from "posthog-js/dist/module.full.no-external.js";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ANALYTICS_SCHEMA_VERSION,
  analyticsProperties,
  isCrashReportsEnabled,
  isUsageAnalyticsEnabled,
  POSTHOG_API_HOST,
  POSTHOG_PROJECT_TOKEN,
  setCrashReportsEnabled,
  setUsageAnalyticsEnabled,
} from "@/lib/analytics";
import { type AppConfig, loadConfig, patchConfig } from "@/lib/config";
import { desktop } from "@/lib/desktop";
import { qk } from "@/lib/queryKeys";

interface TelemetryContextValue {
  usageAnalytics: boolean;
  crashReports: boolean;
  doNotTrack: boolean;
  setUsageAnalytics: (enabled: boolean) => void;
  setCrashReports: (enabled: boolean) => void;
}

const TelemetryContext = createContext<TelemetryContextValue | undefined>(undefined);

export function useTelemetry() {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error("useTelemetry must be used within a TelemetryProvider");
  return ctx;
}

let posthogInitialized = false;

function initPostHog(crashReports: boolean): void {
  if (posthogInitialized) return;
  if (!import.meta.env.PROD || !POSTHOG_PROJECT_TOKEN) return;
  posthogInitialized = true;
  posthog.init(POSTHOG_PROJECT_TOKEN, {
    api_host: POSTHOG_API_HOST,
    person_profiles: "identified_only",
    capture_pageview: false,
    capture_exceptions: crashReports,
    opt_out_useragent_filter: true,
    before_send: (event) => {
      if (!event) return null;
      const isException = event.event === "$exception";
      if (isException && !isCrashReportsEnabled()) return null;
      if (!isException && !isUsageAnalyticsEnabled()) return null;
      return event;
    },
  });
  posthog.register({
    $current_url: "bloxbot://app/loading",
    $host: "app",
    $pathname: "/loading",
    app: "bloxbot",
    analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
    analytics_detail_enabled: true,
    app_platform: navigator.platform,
    app_runtime: window.bloxbot ? "electron" : "browser",
    app_screen: "loading",
    app_user_agent: navigator.userAgent,
  });
  desktop.getVersion().then(
    (version) => {
      posthog.register({ app_version: version });
      posthog.capture("app_opened", analyticsProperties("app", { app_version: version }));
    },
    () => posthog.capture("app_opened", analyticsProperties("app", { app_version: "unknown" })),
  );
}

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const { data: config } = useQuery<AppConfig>({
    queryKey: qk.config,
    queryFn: loadConfig,
  });
  const { data: dnt } = useQuery({
    queryKey: ["doNotTrack"],
    queryFn: () => desktop.getDoNotTrack(),
  });

  const doNotTrack = dnt === true;
  const [usageAnalytics, setUsageAnalyticsState] = useState(true);
  const [crashReports, setCrashReportsState] = useState(true);
  const [showNotice, setShowNotice] = useState(false);
  const initializedRef = useRef(false);

  // Apply config when it arrives.
  useEffect(() => {
    if (!config || dnt === undefined) return;

    const usage = config.usageAnalytics !== "off";
    const crash = config.crashReports !== "off";
    setUsageAnalyticsState(usage);
    setCrashReportsState(crash);
    setUsageAnalyticsEnabled(usage);
    setCrashReportsEnabled(crash);

    if (doNotTrack) {
      setUsageAnalyticsEnabled(false);
      setCrashReportsEnabled(false);
      setUsageAnalyticsState(false);
      setCrashReportsState(false);
      return;
    }

    if (!config.telemetryNoticeShown) {
      setShowNotice(true);
      return;
    }

    // Subsequent launch with at least one toggle on -- init immediately.
    if ((usage || crash) && !initializedRef.current) {
      initializedRef.current = true;
      initPostHog(crash);
    }
  }, [config, dnt, doNotTrack]);

  const handleNoticeAccept = useCallback(() => {
    setShowNotice(false);
    patchConfig({ telemetryNoticeShown: true }).catch(() => {});
    initializedRef.current = true;
    initPostHog(true);
  }, []);

  const handleNoticeTurnOff = useCallback(() => {
    setShowNotice(false);
    setUsageAnalyticsState(false);
    setCrashReportsState(false);
    setUsageAnalyticsEnabled(false);
    setCrashReportsEnabled(false);
    patchConfig({
      telemetryNoticeShown: true,
      usageAnalytics: "off",
      crashReports: "off",
    }).catch(() => {});
    // Do NOT init PostHog -- both toggles are off.
  }, []);

  const setUsageAnalyticsToggle = useCallback((enabled: boolean) => {
    setUsageAnalyticsState(enabled);
    setUsageAnalyticsEnabled(enabled);
    patchConfig({ usageAnalytics: enabled ? "on" : "off" }).catch(() => {});
    if (enabled && !posthogInitialized) {
      initializedRef.current = true;
      initPostHog(isCrashReportsEnabled());
    }
  }, []);

  const setCrashReportsToggle = useCallback((enabled: boolean) => {
    setCrashReportsState(enabled);
    setCrashReportsEnabled(enabled);
    patchConfig({ crashReports: enabled ? "on" : "off" }).catch(() => {});
    if (enabled && !posthogInitialized) {
      initializedRef.current = true;
      initPostHog(true);
    }
  }, []);

  const value: TelemetryContextValue = {
    usageAnalytics,
    crashReports,
    doNotTrack,
    setUsageAnalytics: setUsageAnalyticsToggle,
    setCrashReports: setCrashReportsToggle,
  };

  return (
    <TelemetryContext.Provider value={value}>
      {showNotice && (
        <TelemetryNotice onAccept={handleNoticeAccept} onTurnOff={handleNoticeTurnOff} />
      )}
      {children}
    </TelemetryContext.Provider>
  );
}

function TelemetryNotice({ onAccept, onTurnOff }: { onAccept: () => void; onTurnOff: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="mx-4 w-full max-w-sm rounded-xl border bg-card p-6 shadow-lg">
        <h2 className="text-base font-semibold text-foreground">Usage data &amp; crash reports</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          BloxBot collects anonymous usage data and crash reports to improve the app. No prompts,
          code, or file contents are ever collected. You can turn this off now or anytime in
          Settings.
        </p>
        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onTurnOff}
            className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Turn off telemetry
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
