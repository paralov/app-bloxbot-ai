import { Data, Effect, Schema } from "effect";
import {
  type ExplorerDetailsRequest,
  type ExplorerEdit,
  type ExplorerEditResult,
  ExplorerEditResultSchema,
  type ExplorerNodeDetails,
  ExplorerNodeDetailsSchema,
  type ExplorerSyncRequest,
  type ExplorerSyncResult,
  ExplorerSyncResultSchema,
} from "@/lib/explorer";
import {
  type AppConfig,
  AppConfigPatchSchema,
  AppConfigSchema,
  type BlenderToolsState,
  DEFAULT_APP_CONFIG,
  type DesktopApi,
  type InstructionFile,
  InstructionFileSchema,
  type ModelFileInfo,
  type ModelUploadResult,
  type OpenCodeInfo,
  OpenCodeInfoSchema,
  type OpenCodeStartupProgress,
  type StudioMcpStatus,
  StudioMcpStatusSchema,
  type SystemNotification,
  type UpdateInfo,
  UpdateInfoSchema,
  type UploadAccess,
} from "@/types/desktop";
import {
  type StudioTargetDiscovery,
  StudioTargetDiscoverySchema,
  type StudioTargetSelection,
  StudioTargetSelectionSchema,
} from "@/types/studioTarget";

const CONFIG_KEY = "bloxbot-config";
const DEFAULT_CONFIG: AppConfig = DEFAULT_APP_CONFIG;

export class DesktopError extends Data.TaggedError("DesktopError")<{
  message: string;
  cause?: unknown;
}> {}

interface DesktopEffects {
  readonly getExplorerNodeDetails: (
    studioId: string,
    request: ExplorerDetailsRequest,
  ) => Effect.Effect<ExplorerNodeDetails | null, DesktopError>;
  readonly editExplorerObject: (
    studioId: string,
    edit: ExplorerEdit,
  ) => Effect.Effect<ExplorerEditResult, DesktopError>;
  readonly syncExplorerTree: (
    studioId: string,
    request: ExplorerSyncRequest,
  ) => Effect.Effect<ExplorerSyncResult, DesktopError>;
  readonly getOpenCodeInfo: Effect.Effect<OpenCodeInfo, DesktopError>;
  readonly getOpenCodeInstallFolder: Effect.Effect<string | null, DesktopError>;
  readonly getStudioMcpStatus: Effect.Effect<StudioMcpStatus, DesktopError>;
  readonly getVersion: Effect.Effect<string, DesktopError>;
  readonly getInstructionFiles: Effect.Effect<readonly InstructionFile[], DesktopError>;
  readonly openUrl: (url: string) => Effect.Effect<void, DesktopError>;
  readonly showSystemNotification: (
    notification: SystemNotification,
  ) => Effect.Effect<boolean, DesktopError>;
  readonly loadConfig: Effect.Effect<AppConfig, DesktopError>;
  readonly patchConfig: (patch: Partial<AppConfig>) => Effect.Effect<void, DesktopError>;
  readonly setSystemPrompt: (systemPrompt: string | null) => Effect.Effect<void, DesktopError>;
  readonly checkForUpdate: Effect.Effect<UpdateInfo | null, DesktopError>;
  readonly installUpdate: Effect.Effect<void, DesktopError>;
  readonly relaunch: Effect.Effect<void, DesktopError>;
  readonly getBlenderToolsState: Effect.Effect<BlenderToolsState, DesktopError>;
  readonly installBlenderTools: Effect.Effect<void, DesktopError>;
  readonly cancelBlenderTools: Effect.Effect<void, DesktopError>;
  readonly openBlender: Effect.Effect<void, DesktopError>;
  readonly removeBlenderTools: Effect.Effect<void, DesktopError>;
  readonly getUploadAccess: (studioKey: string | null) => Effect.Effect<UploadAccess, DesktopError>;
  readonly readModelFile: (url: string) => Effect.Effect<ModelFileInfo | null, DesktopError>;
  readonly uploadModelToPlace: (
    url: string,
    studioKey: string,
    hash: string,
  ) => Effect.Effect<ModelUploadResult, DesktopError>;
  readonly discoverStudioTargets: Effect.Effect<StudioTargetDiscovery, DesktopError>;
  readonly selectStudioTarget: (
    targetKey: string,
  ) => Effect.Effect<StudioTargetSelection, DesktopError>;
}

type StartupProgressListener = (progress: OpenCodeStartupProgress) => void;

const loadBrowserConfig = Effect.gen(function* () {
  const stored = yield* Effect.try({
    try: () => {
      const contents = window.localStorage.getItem(CONFIG_KEY);
      return contents ? (JSON.parse(contents) as unknown) : DEFAULT_CONFIG;
    },
    catch: (cause) => new DesktopError({ message: "Failed to load browser configuration", cause }),
  });
  const candidate =
    stored !== null && typeof stored === "object"
      ? { ...DEFAULT_CONFIG, ...stored }
      : DEFAULT_CONFIG;
  return yield* Schema.decodeUnknown(AppConfigSchema)(candidate).pipe(
    Effect.mapError(
      (cause) => new DesktopError({ message: "Browser configuration is invalid", cause }),
    ),
  );
}).pipe(Effect.catchAll(() => Effect.succeed(DEFAULT_CONFIG)));

const browserEffects: DesktopEffects = {
  getExplorerNodeDetails: () =>
    Effect.fail(new DesktopError({ message: "Explorer requires the desktop app." })),
  editExplorerObject: () =>
    Effect.fail(new DesktopError({ message: "Explorer requires the desktop app." })),
  syncExplorerTree: () =>
    Effect.fail(new DesktopError({ message: "Explorer requires the desktop app." })),
  getOpenCodeInfo: Effect.fail(
    new DesktopError({
      message: "The desktop service is unavailable. Start BloxBot with pnpm dev.",
    }),
  ),
  getOpenCodeInstallFolder: Effect.succeed(null),
  getStudioMcpStatus: Effect.succeed({ state: "starting" }),
  getVersion: Effect.succeed("0.5.2"),
  getInstructionFiles: Effect.succeed([]),
  openUrl: (url) =>
    Effect.sync(() => window.open(url, "_blank", "noopener,noreferrer")).pipe(Effect.asVoid),
  showSystemNotification: () => Effect.succeed(false),
  loadConfig: loadBrowserConfig,
  patchConfig: (input) =>
    Effect.gen(function* () {
      const patch = yield* Schema.decodeUnknown(AppConfigPatchSchema)(input).pipe(
        Effect.mapError(
          (cause) => new DesktopError({ message: "Browser configuration patch is invalid", cause }),
        ),
      );
      const current = yield* loadBrowserConfig;
      yield* Effect.try({
        try: () =>
          window.localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...current, ...patch })),
        catch: (cause) =>
          new DesktopError({ message: "Failed to save browser configuration", cause }),
      });
    }),
  setSystemPrompt: (systemPrompt) => browserEffects.patchConfig({ systemPrompt }),
  checkForUpdate: Effect.succeed(null),
  installUpdate: Effect.fail(
    new DesktopError({ message: "Updates are only available in the desktop app." }),
  ),
  relaunch: Effect.sync(() => window.location.reload()),
  getBlenderToolsState: Effect.succeed({ state: "unsupported" }),
  installBlenderTools: Effect.fail(
    new DesktopError({ message: "Blender can only be set up in the desktop app." }),
  ),
  cancelBlenderTools: Effect.void,
  openBlender: Effect.fail(
    new DesktopError({ message: "Blender can only be opened from the desktop app." }),
  ),
  removeBlenderTools: Effect.void,
  getUploadAccess: () => Effect.succeed({ state: "no_studio", modelsFolder: "" }),
  readModelFile: () => Effect.succeed(null),
  uploadModelToPlace: () => Effect.succeed({ status: "needs_setup", access: "no_studio" }),
  discoverStudioTargets: Effect.fail(
    new DesktopError({ message: "Studio targets are only available in the desktop app." }),
  ),
  selectStudioTarget: () =>
    Effect.fail(
      new DesktopError({ message: "Studio targets are only available in the desktop app." }),
    ),
};

const invoke = <A>(message: string, operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new DesktopError({
        message: cause instanceof Error ? `${message}: ${cause.message}` : message,
        cause,
      }),
  });

const decodeBridgeValue =
  <A, I>(message: string, schema: Schema.Schema<A, I>) =>
  <E>(effect: Effect.Effect<unknown, E>) =>
    effect.pipe(
      Effect.flatMap(Schema.decodeUnknown(schema)),
      Effect.mapError((cause) =>
        cause instanceof DesktopError ? cause : new DesktopError({ message, cause }),
      ),
    );

function makeBridgeEffects(api: DesktopApi): DesktopEffects {
  return {
    getExplorerNodeDetails: (studioId, request) =>
      invoke("Failed to read this object from Studio", () =>
        api.getExplorerNodeDetails(studioId, request),
      ).pipe(
        decodeBridgeValue("Object details are invalid", Schema.NullOr(ExplorerNodeDetailsSchema)),
      ),
    editExplorerObject: (studioId, edit) =>
      invoke("Failed to change this object in Studio", () =>
        api.editExplorerObject(studioId, edit),
      ).pipe(decodeBridgeValue("Studio's answer is invalid", ExplorerEditResultSchema)),
    syncExplorerTree: (studioId, request) =>
      invoke("Failed to read Studio's instance tree", () =>
        api.syncExplorerTree(studioId, request),
      ).pipe(decodeBridgeValue("Studio's instance tree is invalid", ExplorerSyncResultSchema)),
    getOpenCodeInfo: invoke("Failed to get OpenCode connection details", () =>
      api.getOpenCodeInfo(),
    ).pipe(decodeBridgeValue("OpenCode connection details are invalid", OpenCodeInfoSchema)),
    getOpenCodeInstallFolder: invoke("Failed to get the OpenCode folder", () =>
      api.getOpenCodeInstallFolder(),
    ).pipe(decodeBridgeValue("OpenCode folder is invalid", Schema.NullOr(Schema.String))),
    getStudioMcpStatus: invoke("Failed to get the Studio MCP status", () =>
      api.getStudioMcpStatus(),
    ).pipe(decodeBridgeValue("Studio MCP status is invalid", StudioMcpStatusSchema)),
    getVersion: invoke("Failed to get the app version", () => api.getVersion()).pipe(
      decodeBridgeValue("Desktop app version is invalid", Schema.String),
    ),
    getInstructionFiles: invoke("Failed to read instruction files", () =>
      api.getInstructionFiles(),
    ).pipe(decodeBridgeValue("Instruction files are invalid", Schema.Array(InstructionFileSchema))),
    openUrl: (url) => invoke("Failed to open the URL", () => api.openUrl(url)),
    showSystemNotification: (notification) =>
      invoke("Failed to show a system notification", () =>
        api.showSystemNotification(notification),
      ).pipe(decodeBridgeValue("System notification result is invalid", Schema.Boolean)),
    loadConfig: invoke("Failed to load configuration", () => api.loadConfig()).pipe(
      decodeBridgeValue("Desktop configuration is invalid", AppConfigSchema),
    ),
    patchConfig: (patch) => invoke("Failed to save configuration", () => api.patchConfig(patch)),
    setSystemPrompt: (systemPrompt) =>
      invoke("Failed to save the system prompt", () => api.setSystemPrompt(systemPrompt)),
    checkForUpdate: invoke("Failed to check for updates", () => api.checkForUpdate()).pipe(
      decodeBridgeValue("Update information is invalid", Schema.NullOr(UpdateInfoSchema)),
    ),
    installUpdate: invoke("Failed to install the update", () => api.installUpdate()),
    relaunch: invoke("Failed to relaunch the app", () => api.relaunch()),
    getBlenderToolsState: invoke("Failed to check Blender", () => api.getBlenderToolsState()),
    installBlenderTools: invoke("Failed to set up Blender", () => api.installBlenderTools()),
    cancelBlenderTools: invoke("Failed to stop setting up Blender", () => api.cancelBlenderTools()),
    openBlender: invoke("Failed to open Blender", () => api.openBlender()),
    removeBlenderTools: invoke("Failed to remove Blender", () => api.removeBlenderTools()),
    getUploadAccess: (studioKey) =>
      invoke("Failed to check uploads", () => api.getUploadAccess(studioKey)),
    readModelFile: (url) => invoke("Failed to read the model", () => api.readModelFile(url)),
    uploadModelToPlace: (url, studioKey, hash) =>
      invoke("Failed to upload the model", () => api.uploadModelToPlace(url, studioKey, hash)),
    discoverStudioTargets: invoke("Failed to discover Studio targets", () =>
      api.discoverStudioTargets(),
    ).pipe(decodeBridgeValue("Studio target discovery is invalid", StudioTargetDiscoverySchema)),
    selectStudioTarget: (targetKey) =>
      invoke("Failed to select the Studio target", () => api.selectStudioTarget(targetKey)).pipe(
        decodeBridgeValue("Studio target selection is invalid", StudioTargetSelectionSchema),
      ),
  };
}

export const desktopEffects: DesktopEffects = window.bloxbot
  ? makeBridgeEffects(window.bloxbot)
  : browserEffects;

const runPromise = <A>(effect: Effect.Effect<A, DesktopError>): Promise<A> =>
  Effect.runPromise(effect);

/** Promise-only adapter consumed by React and exposed by the Electron bridge contract. */
export const desktop: DesktopApi = {
  syncExplorerTree: (studioId, request) =>
    runPromise(desktopEffects.syncExplorerTree(studioId, request)),
  // Trees are large and come from our own main process, so these aren't decoded one by one.
  onExplorerTreeUpdate: (listener) => window.bloxbot?.onExplorerTreeUpdate(listener) ?? (() => {}),
  readInstructions: () => window.bloxbot?.readInstructions() ?? Promise.resolve(""),
  saveInstructions: (text) => window.bloxbot?.saveInstructions(text) ?? Promise.resolve(),
  getExplorerNodeDetails: (studioId, request) =>
    runPromise(desktopEffects.getExplorerNodeDetails(studioId, request)),
  editExplorerObject: (studioId, edit) =>
    runPromise(desktopEffects.editExplorerObject(studioId, edit)),
  getOpenCodeInfo: () => runPromise(desktopEffects.getOpenCodeInfo),
  getOpenCodeInstallFolder: () => runPromise(desktopEffects.getOpenCodeInstallFolder),
  getStudioMcpStatus: () => runPromise(desktopEffects.getStudioMcpStatus),
  onOpenCodeStartupProgress: (listener: StartupProgressListener) =>
    window.bloxbot?.onOpenCodeStartupProgress(listener) ?? (() => {}),
  getVersion: () => runPromise(desktopEffects.getVersion),
  getInstructionFiles: () => runPromise(desktopEffects.getInstructionFiles),
  openUrl: (url) => runPromise(desktopEffects.openUrl(url)),
  showSystemNotification: (notification) =>
    runPromise(desktopEffects.showSystemNotification(notification)),
  onSystemNotificationClick: (listener) =>
    window.bloxbot?.onSystemNotificationClick(listener) ?? (() => {}),
  openNotificationSettings: () => window.bloxbot?.openNotificationSettings() ?? Promise.resolve(),
  loadConfig: () => runPromise(desktopEffects.loadConfig),
  patchConfig: (patch) => runPromise(desktopEffects.patchConfig(patch)),
  setSystemPrompt: (systemPrompt) => runPromise(desktopEffects.setSystemPrompt(systemPrompt)),
  checkForUpdate: () => runPromise(desktopEffects.checkForUpdate),
  installUpdate: () => runPromise(desktopEffects.installUpdate),
  relaunch: () => runPromise(desktopEffects.relaunch),
  getBlenderToolsState: () => runPromise(desktopEffects.getBlenderToolsState),
  installBlenderTools: () => runPromise(desktopEffects.installBlenderTools),
  cancelBlenderTools: () => runPromise(desktopEffects.cancelBlenderTools),
  openBlender: () => runPromise(desktopEffects.openBlender),
  removeBlenderTools: () => runPromise(desktopEffects.removeBlenderTools),
  getUploadAccess: (studioKey) => runPromise(desktopEffects.getUploadAccess(studioKey)),
  readModelFile: (url) => runPromise(desktopEffects.readModelFile(url)),
  uploadModelToPlace: (url, studioKey, hash) =>
    runPromise(desktopEffects.uploadModelToPlace(url, studioKey, hash)),
  onModelUploadStep: (listener) => window.bloxbot?.onModelUploadStep(listener) ?? (() => {}),
  onBlenderSetupProgress: (listener) =>
    window.bloxbot?.onBlenderSetupProgress(listener) ?? (() => {}),
  discoverStudioTargets: () => runPromise(desktopEffects.discoverStudioTargets),
  selectStudioTarget: (targetKey) => runPromise(desktopEffects.selectStudioTarget(targetKey)),
  onMainError: (listener) => window.bloxbot?.onMainError(listener) ?? (() => {}),
};
