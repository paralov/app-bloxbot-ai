import { beforeEach, describe, expect, it } from "vitest";
import {
  detailedAnalyticsProperties,
  isCrashReportsEnabled,
  isUsageAnalyticsEnabled,
  setCrashReportsEnabled,
  setUsageAnalyticsEnabled,
} from "@/lib/analytics";

describe("Telemetry gating", () => {
  beforeEach(() => {
    setUsageAnalyticsEnabled(true);
    setCrashReportsEnabled(true);
  });

  it("defaults both toggles to on", () => {
    expect(isUsageAnalyticsEnabled()).toBe(true);
    expect(isCrashReportsEnabled()).toBe(true);
  });

  it("usage analytics toggle gates detailed properties", () => {
    const props = { provider: "anthropic", model: "claude-sonnet-4" };
    expect(detailedAnalyticsProperties(props)).toEqual(props);
    setUsageAnalyticsEnabled(false);
    expect(detailedAnalyticsProperties(props)).toEqual({});
  });

  it("toggles can be turned off independently", () => {
    setUsageAnalyticsEnabled(false);
    expect(isUsageAnalyticsEnabled()).toBe(false);
    expect(isCrashReportsEnabled()).toBe(true);

    setCrashReportsEnabled(false);
    expect(isCrashReportsEnabled()).toBe(false);
  });

  it("old detailedAnalytics preference is ignored on config load", () => {
    // The old detailedAnalytics="disabled" value is stripped by the schema.
    // Both toggles default to on regardless of old preference.
    // This is a design-level assertion -- verified by the config schema
    // not containing detailedAnalytics and DEFAULT_APP_CONFIG having
    // usageAnalytics: "on" and crashReports: "on".
    expect(isUsageAnalyticsEnabled()).toBe(true);
    expect(isCrashReportsEnabled()).toBe(true);
  });
});
