import { Schema } from "effect";

const MutableStrings = Schema.mutable(Schema.Array(Schema.String));

export const RobloxStudioPlaceSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    active: Schema.Boolean,
  }),
);

export type RobloxStudioPlace = typeof RobloxStudioPlaceSchema.Type;

export const StudioAssignmentSchema = Schema.mutable(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
  }),
);

export type StudioAssignment = typeof StudioAssignmentSchema.Type;

export const ThemePreferenceSchema = Schema.Literal("light", "dark", "system");
export const DetailedAnalyticsPreferenceSchema = Schema.Literal("unset", "enabled", "disabled");

export type ThemePreference = typeof ThemePreferenceSchema.Type;

export const AppConfigSchema = Schema.mutable(
  Schema.Struct({
    lastModel: Schema.NullOr(Schema.String),
    hiddenModels: MutableStrings,
    theme: ThemePreferenceSchema,
    detailedAnalytics: DetailedAnalyticsPreferenceSchema,
    studioAssignments: Schema.Record({ key: Schema.String, value: StudioAssignmentSchema }),
  }),
);

export type AppConfig = typeof AppConfigSchema.Type;

export const DEFAULT_APP_CONFIG: AppConfig = {
  lastModel: null,
  hiddenModels: [],
  theme: "system",
  detailedAnalytics: "unset",
  studioAssignments: {},
};

export const AppConfigPatchSchema = Schema.partial(AppConfigSchema);

export const OpenCodeInfoSchema = Schema.mutable(
  Schema.Struct({
    authorization: Schema.String,
    port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65_535)),
    workspace: Schema.String,
  }),
);

export type OpenCodeInfo = typeof OpenCodeInfoSchema.Type;

export type OpenCodeStartupProgress =
  | { phase: "checking" }
  | {
      phase: "downloading";
      downloadedBytes: number;
      totalBytes: number | null;
      bytesPerSecond: number;
    }
  | { phase: "verifying" }
  | { phase: "installing" }
  | { phase: "starting" };

export const UpdateInfoSchema = Schema.mutable(
  Schema.Struct({
    version: Schema.String,
    body: Schema.NullOr(Schema.String),
  }),
);

export type UpdateInfo = typeof UpdateInfoSchema.Type;

export interface DesktopApi {
  getOpenCodeInfo(): Promise<OpenCodeInfo>;
  onOpenCodeStartupProgress(listener: (progress: OpenCodeStartupProgress) => void): () => void;
  getVersion(): Promise<string>;
  openUrl(url: string): Promise<void>;
  loadConfig(): Promise<AppConfig>;
  patchConfig(patch: Partial<AppConfig>): Promise<void>;
  checkForUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  relaunch(): Promise<void>;
  listRobloxStudios(): Promise<RobloxStudioPlace[]>;
}
