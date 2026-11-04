import { Schema } from "effect";
import type {
  ExplorerDetailsRequest,
  ExplorerEdit,
  ExplorerEditResult,
  ExplorerNodeDetails,
  ExplorerSyncRequest,
  ExplorerSyncResult,
  ExplorerTreeUpdate,
} from "../lib/explorer";
import {
  type StudioTargetDiscovery,
  StudioTargetSchema,
  type StudioTargetSelection,
} from "./studioTarget";

const MutableStrings = Schema.mutable(Schema.Array(Schema.String));

export const ThemePreferenceSchema = Schema.Literal("light", "dark", "system");
export const DetailedAnalyticsPreferenceSchema = Schema.Literal("unset", "enabled", "disabled");

export type ThemePreference = typeof ThemePreferenceSchema.Type;

export const NotificationKindsSchema = Schema.Struct({
  finished: Schema.Boolean,
  waiting: Schema.Boolean,
  failed: Schema.Boolean,
  app: Schema.Boolean,
});

export type NotificationKinds = typeof NotificationKindsSchema.Type;

export const AppConfigSchema = Schema.mutable(
  Schema.Struct({
    lastModel: Schema.NullOr(Schema.String),
    hiddenModels: MutableStrings,
    theme: ThemePreferenceSchema,
    detailedAnalytics: DetailedAnalyticsPreferenceSchema,
    // Highest analytics policy notice the user has seen; 0 predates the opt-out model.
    analyticsNoticeVersion: Schema.Number,
    studioTargetsBySession: Schema.Record({ key: Schema.String, value: StudioTargetSchema }),
    // Chats someone chose to use for work that has nothing to do with Studio.
    chatsWithoutStudio: MutableStrings,
    // Places someone picked by hand, as opposed to whichever Studio happened to be open.
    chatsWithChosenPlace: MutableStrings,
    // The Studio a chat's latest message was sent to, which says which one it used if it did.
    routedTargetsBySession: Schema.Record({ key: Schema.String, value: StudioTargetSchema }),
    studioSetupSkipped: Schema.Boolean,
    // Only for people who haven't chosen kinds yet: off here means every kind starts off.
    systemNotifications: Schema.Boolean,
    notificationKinds: Schema.NullOr(NotificationKindsSchema),
    notificationSound: Schema.Boolean,
    notificationsOffered: Schema.Boolean,
    // The first model a reply showed, so the second can offer uploads, once.
    firstModelShown: Schema.NullOr(Schema.String),
    uploadsOffered: Schema.Boolean,
    // What the user wrote in Settings; null follows BloxBot's default as it changes.
    systemPrompt: Schema.NullOr(Schema.String),
    promptsSent: Schema.Number,
    starCalloutShown: Schema.Boolean,
  }),
);

export type AppConfig = typeof AppConfigSchema.Type;

export const DEFAULT_APP_CONFIG: AppConfig = {
  lastModel: null,
  hiddenModels: [],
  theme: "system",
  detailedAnalytics: "unset",
  analyticsNoticeVersion: 0,
  studioTargetsBySession: {},
  chatsWithoutStudio: [],
  chatsWithChosenPlace: [],
  routedTargetsBySession: {},
  studioSetupSkipped: false,
  systemNotifications: true,
  notificationKinds: null,
  notificationSound: true,
  notificationsOffered: false,
  firstModelShown: null,
  uploadsOffered: false,
  systemPrompt: null,
  promptsSent: 0,
  starCalloutShown: false,
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

export const InstructionFileSchema = Schema.Struct({
  path: Schema.String,
  scope: Schema.Literal("global", "project"),
  chars: Schema.Number,
  content: Schema.String,
});

export type InstructionFile = typeof InstructionFileSchema.Type;

export const UpdateInfoSchema = Schema.mutable(
  Schema.Struct({
    version: Schema.String,
    body: Schema.NullOr(Schema.String),
  }),
);

export type UpdateInfo = typeof UpdateInfoSchema.Type;

/**
 * Whether BloxBot could start Roblox Studio's MCP helper. `not_installed` means the helper
 * isn't on this computer, `unavailable` means it started but closed before it connected.
 */
export const StudioMcpStatusSchema = Schema.Struct({
  state: Schema.Literal("starting", "connected", "not_installed", "unavailable"),
});

export type StudioMcpStatus = typeof StudioMcpStatusSchema.Type;

/** A main-process error forwarded to the renderer, which reports it through PostHog. */
export interface MainErrorReport {
  source: string;
  name: string;
  message: string;
  stack?: string;
}

export const SystemNotificationSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
});

export type SystemNotification = typeof SystemNotificationSchema.Type;

export interface DesktopApi {
  /** Brings the tree up to date, sending the parts that changed to `onExplorerTreeUpdate`. */
  syncExplorerTree(studioId: string, request: ExplorerSyncRequest): Promise<ExplorerSyncResult>;
  onExplorerTreeUpdate(listener: (update: ExplorerTreeUpdate) => void): () => void;
  /** Null when reading it in the background would have to run a script. */
  getExplorerNodeDetails(
    studioId: string,
    request: ExplorerDetailsRequest,
  ): Promise<ExplorerNodeDetails | null>;
  editExplorerObject(studioId: string, edit: ExplorerEdit): Promise<ExplorerEditResult>;
  discoverStudioTargets(): Promise<StudioTargetDiscovery>;
  selectStudioTarget(targetKey: string): Promise<StudioTargetSelection>;
  getOpenCodeInfo(): Promise<OpenCodeInfo>;
  /** The folder OpenCode installs into, for antivirus exclusions. Null outside the desktop app. */
  getOpenCodeInstallFolder(): Promise<string | null>;
  getStudioMcpStatus(): Promise<StudioMcpStatus>;
  onOpenCodeStartupProgress(listener: (progress: OpenCodeStartupProgress) => void): () => void;
  getVersion(): Promise<string>;
  getInstructionFiles(): Promise<readonly InstructionFile[]>;
  /** BloxBot's AGENTS.md, which is empty until the user writes something. */
  readInstructions(): Promise<string>;
  saveInstructions(text: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  showSystemNotification(notification: SystemNotification): Promise<boolean>;
  onSystemNotificationClick(listener: (id: string) => void): () => void;
  /** Opens the page where the system lets people allow BloxBot's notifications. */
  openNotificationSettings(): Promise<void>;
  loadConfig(): Promise<AppConfig>;
  patchConfig(patch: Partial<AppConfig>): Promise<void>;
  setSystemPrompt(systemPrompt: string | null): Promise<void>;
  checkForUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  relaunch(): Promise<void>;
  getBlenderToolsState(): Promise<BlenderToolsState>;
  /** Resolves once setup has finished, and rejects if it can't, with a BlenderFailureReason in its message. */
  installBlenderTools(): Promise<void>;
  cancelBlenderTools(): Promise<void>;
  openBlender(): Promise<void>;
  removeBlenderTools(): Promise<void>;
  onBlenderSetupProgress(listener: (progress: BlenderSetupProgress) => void): () => void;
  getRobloxUploadState(): Promise<RobloxUploadState>;
  /** Asks Roblox what a key can do, and compares its owner with this Studio's account. Nothing is saved. */
  checkRobloxKey(key: string, studioKey: string | null): Promise<RobloxKeyCheck>;
  /** Checks the key again and keeps it, encrypted. Rejects if it can't upload. */
  saveRobloxKey(key: string): Promise<void>;
  forgetRobloxKey(): Promise<void>;
  /** Null when the link isn't a model file BloxBot can read. */
  readModelFile(url: string): Promise<ModelFileInfo | null>;
  /** `hash` is the file the person looked at, and nothing else gets sent. */
  uploadModelToPlace(url: string, studioKey: string, hash: string): Promise<ModelUploadResult>;
  onModelUploadStep(listener: (url: string, step: ModelUploadStep) => void): () => void;
  /**
   * Receives errors from the main process so the renderer can report them. Subscribing
   * tells the main process the window is ready, which flushes errors buffered until then.
   */
  onMainError(listener: (report: MainErrorReport) => void): () => void;
}

export type RobloxUploadState =
  | { state: "unavailable" }
  | { state: "off" }
  | { state: "on"; ownerId: string; ownerName: string | null };

export type RobloxKeyCheck =
  | { result: "not_a_key" }
  | { result: "unreachable" }
  | {
      result: "checked";
      ownerId: string;
      ownerName: string | null;
      active: boolean;
      canUpload: boolean;
      reachesGroups: boolean;
      extraAccess: string[];
      /** Who's signed in to Studio, or null when Studio isn't open to ask. */
      studio: { id: string; name: string | null } | null;
    };

export interface ModelFileInfo {
  name: string;
  fileName: string;
  path: string;
  data: Uint8Array;
  kind: "fbx" | "glb";
  sizeBytes: number;
  hash: string;
  /** What already happened to exactly these bytes. */
  sent: { assetId: string | null; moderation: "approved" | "rejected" | "checking" } | null;
}

export type ModelUploadStep = "uploading" | "checking" | "adding";

export type ModelUploadFailure =
  | "no_file"
  | "file_changed"
  | "no_key"
  | "no_studio"
  | "key_off"
  | "key_rejected"
  | "rate_limited"
  | "file_rejected"
  | "network";

export type ModelUploadResult =
  | { status: "added"; assetId: string; path: string }
  | { status: "rejected"; assetId: string }
  | { status: "checking"; assetId: string }
  | { status: "not_added"; assetId: string }
  | { status: "wrong_account"; keyOwner: string; studio: string }
  | { status: "failed"; reason: ModelUploadFailure };

export type BlenderSetupStep = "downloading" | "unpacking" | "connecting";

export interface BlenderSetupProgress {
  step: BlenderSetupStep;
  downloadedBytes: number;
  totalBytes: number;
}

export type BlenderFailureReason = "disk_full" | "network" | "blocked" | "corrupt" | "other";

export type BlenderToolsState =
  | { state: "unsupported" }
  | { state: "not_installed" }
  | { state: "installing"; progress: BlenderSetupProgress | null }
  | { state: "ready"; running: boolean };
