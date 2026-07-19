import { Effect } from "effect";
import { desktopEffects } from "@/lib/desktop";
import type { AppConfig } from "@/types/desktop";

export type { AppConfig } from "@/types/desktop";

export const loadConfigEffect = desktopEffects.loadConfig;

export const patchConfigEffect = (patch: Partial<AppConfig>) => desktopEffects.patchConfig(patch);

// Promise adapters are kept at the React boundary used by PreferencesProvider.
export const loadConfig = (): Promise<AppConfig> => Effect.runPromise(loadConfigEffect);

export const patchConfig = (patch: Partial<AppConfig>): Promise<void> =>
  Effect.runPromise(patchConfigEffect(patch));
