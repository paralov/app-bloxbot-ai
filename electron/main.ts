import { rename, readFile, rm, writeFile } from "node:fs/promises";
import {
  forgetRobloxKey,
  getRobloxUploadState,
  inspectRobloxKey,
  keyIsUsable,
  readModelFile,
  readSentModel,
  robloxUserName,
  saveRobloxKey,
  sendModelToPlace,
  sentModelsFile,
} from "./services/RobloxUpload";
import { isOpenableUrl } from "./openableUrl";
import {
  blenderMcpServerConfig,
  getBlenderToolsState,
  installBlenderTools,
  isBlenderInstalled,
  openBlender,
  removeBlenderTools,
} from "./services/BlenderTools";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, net, Notification, safeStorage, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { Cause, Data, Effect, Layer, ManagedRuntime, Schema } from "effect";

import {
  BlenderSetupProgress,
  type AppConfig,
  AppConfigPatchSchema,
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
  type OpenCodeStartupProgress,
  SystemNotificationSchema,
  ModelUploadResult,
} from "../src/types/desktop";
import {
  ExplorerDetailsRequestSchema,
  ExplorerEditSchema,
  ExplorerNodeDetailsSchema,
  ExplorerSyncRequestSchema,
} from "../src/lib/explorer";
import {
  StudioTargetDiscoverySchema,
  StudioTargetSelectionSchema,
} from "../src/types/studioTarget";
import { handleLastWindowClosed } from "./appLifecycle";
import { createMainErrorReporter } from "./errorReporter";
import { syncExplorerTree } from "./explorerTree";
import { findInstructionFiles, readInstructions, saveInstructions } from "./instructionFiles";
import {
  type CallStudioTool,
  discoverStudioTargets,
  editExplorerObject,
  inspectExplorerNode,
  selectStudioTarget,
  insertUploadedModel,
  readStudioAccount,
} from "./studioQueries";
import { withBlender, withSystemPrompt } from "./opencodeConfig";
import { channels } from "./channels";
import { makeOpenCodeLayer, OpenCode } from "./services/OpenCode";
import { createSystemNotifier, notificationSettingsUrl } from "./systemNotifications";
import { makeStudioMcpBrokerLayer, StudioMcpBroker } from "./services/StudioMcpBroker";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfig: AppConfig = DEFAULT_APP_CONFIG;
const configMutex = Effect.unsafeMakeSemaphore(1);

function configPath(): string {
  return join(app.getPath("userData"), "bloxbot-store.json");
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;

const showSystemNotification = createSystemNotifier({
  isSupported: () => Notification.isSupported(),
  // BloxBot plays its own sound, if the user wants one.
  create: (content) => new Notification({ ...content, silent: true }),
  onClick: (id) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send(channels.systemNotificationClicked, id);
  },
});

function currentUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

const mainErrorReporter = createMainErrorReporter({
  channel: channels.mainError,
  home: app.getPath("home"),
  username: currentUsername(),
});

/** Sends a main-process error to the renderer, which reports it if analytics is on. */
function reportMainError(source: string, error: unknown): void {
  mainErrorReporter.report(source, error);
}

// A monitor observes without replacing Electron's own uncaught-exception handling.
process.on("uncaughtExceptionMonitor", (error) => reportMainError("main_uncaught_exception", error));
// Electron only warns about unhandled rejections; keep that log line and report it.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in the main process:", reason);
  reportMainError("main_unhandled_rejection", reason);
});

const reportLayerFailure = (source: string) => (cause: Cause.Cause<unknown>) =>
  Effect.sync(() => {
    if (!Cause.isInterruptedOnly(cause)) reportMainError(source, Cause.squash(cause));
  });

class DesktopMainError extends Data.TaggedError("DesktopMainError")<{
  message: string;
  cause?: unknown;
}> {}

const studioMcpBrokerLayer = makeStudioMcpBrokerLayer({
  workspace: join(app.getPath("home"), "BloxBot"),
  localAppData: process.env.LOCALAPPDATA,
  comSpec: process.env.ComSpec,
  systemRoot: process.env.SystemRoot,
  // Reported once per launch, after the startup retries, and not when Studio isn't installed.
  onStartFailure: (error) => reportMainError("studio_mcp_broker_start", error),
}).pipe(Layer.tapErrorCause(reportLayerFailure("studio_mcp_broker_start")));

const openCodeBinaryDirectory = join(app.getPath("userData"), "opencode");
const blenderToolsRoot = () => join(app.getPath("userData"), "blender-tools");

const openCodeRuntime = ManagedRuntime.make(
  makeOpenCodeLayer({
      binaryCacheDirectory: openCodeBinaryDirectory,
      // Chromium's network stack, which trusts the certificates installed on the system.
      fetchWithSystemCertificates: (url, init) => net.fetch(url, init),
      workspace: join(app.getPath("home"), "BloxBot"),
      onNetstatMiss: (error) => reportMainError("opencode_netstat_miss", error),
      loadSystemPrompt: () =>
        loadConfig.pipe(
          Effect.map((config) => config.systemPrompt),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
      loadBlenderServer: () =>
        Effect.promise(async () =>
          (await isBlenderInstalled(blenderToolsRoot())) ? blenderMcpServerConfig(blenderToolsRoot()) : null,
        ),
      onStartupProgress: (progress: OpenCodeStartupProgress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channels.openCodeStartupProgress, progress);
        }
      },
    }).pipe(
    Layer.tapErrorCause(reportLayerFailure("opencode_start")),
    Layer.provideMerge(studioMcpBrokerLayer),
  ),
);

function isMissingFile(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}

function parseExternalUrl(rawUrl: string) {
  return Effect.try({
    try: () => new URL(rawUrl),
    catch: (cause) =>
      new DesktopMainError({ message: "Only web, email and local file links can be opened", cause }),
  }).pipe(
    Effect.flatMap((url) =>
      isOpenableUrl(url)
        ? Effect.succeed(url)
        : Effect.fail(
            new DesktopMainError({ message: "Only web, email and local file links can be opened" }),
          ),
    ),
  );
}

function openLink(url: URL) {
  return Effect.tryPromise({
    try: async () => {
      if (url.protocol === "file:") shell.showItemInFolder(fileURLToPath(url));
      else await shell.openExternal(url.href);
    },
    catch: (cause) => new DesktopMainError({ message: "Failed to open URL", cause }),
  });
}

const loadConfig = Effect.gen(function* () {
  const contents = yield* Effect.tryPromise({
    try: () => readFile(configPath(), "utf8"),
    catch: (cause) => new DesktopMainError({ message: "Failed to read app configuration", cause }),
  }).pipe(
    Effect.catchAll((error) =>
      isMissingFile(error.cause) ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
  if (contents === null) return defaultConfig;

  return yield* Effect.gen(function* () {
    const stored = yield* Effect.try({
      try: () => JSON.parse(contents) as unknown,
      catch: (cause) => new DesktopMainError({ message: "App configuration is invalid", cause }),
    });
    const candidate =
      stored !== null && typeof stored === "object" ? { ...defaultConfig, ...stored } : defaultConfig;
    return yield* Schema.decodeUnknown(AppConfigSchema)(candidate).pipe(
      Effect.mapError(
        (cause) => new DesktopMainError({ message: "App configuration is invalid", cause }),
      ),
    );
  }).pipe(
    Effect.tapError((error) => Effect.logWarning(error.message, error.cause)),
    Effect.catchAll(() => Effect.succeed(defaultConfig)),
  );
});

function patchConfig(input: unknown) {
  return Effect.gen(function* () {
    const patch = yield* Schema.decodeUnknown(AppConfigPatchSchema)(input).pipe(
      Effect.mapError(
        (cause) => new DesktopMainError({ message: "App configuration patch is invalid", cause }),
      ),
    );
    const current = yield* loadConfig;
    const next = { ...current, ...patch };
    yield* Effect.tryPromise({
      try: async () => {
        const destination = configPath();
        const temporary = `${destination}.${process.pid}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
          await rename(temporary, destination);
        } catch (cause) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw cause;
        }
      },
      catch: (cause) =>
        new DesktopMainError({ message: "Failed to write app configuration", cause }),
    });
  }).pipe(configMutex.withPermits(1));
}

const runMain = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const StudioKeySchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512));
const RobloxKeySchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8192));
// Instances can nest deeply under long names, so a path gets far more room than an ID.

/** Runs a read against Studio through the broker, keeping Studio's error text for the renderer. */
// OpenCode runs with XDG_CONFIG_HOME inside the workspace (see services/OpenCode.ts).
const openCodeConfigDirectory = () =>
  join(app.getPath("home"), "BloxBot", ".opencode", "config", "opencode");

const queryStudio = <A>(query: (callTool: CallStudioTool) => Promise<A>) =>
  openCodeRuntime.runPromise(
    Effect.gen(function* () {
      const broker = yield* StudioMcpBroker;
      return yield* Effect.tryPromise({
        try: () => query((name, args, options) => Effect.runPromise(broker.callTool(name, args, options))),
        catch: (cause) =>
          new DesktopMainError({
            message: cause instanceof Error ? cause.message : "Studio didn't answer",
            cause,
          }),
      });
    }),
  );

const registerIpcHandlers = Effect.sync(() => {
  ipcMain.on(channels.mainErrorReady, (event) => mainErrorReporter.attach(event.sender));
  ipcMain.handle(channels.getOpenCodeInfo, () =>
    openCodeRuntime.runPromise(
      OpenCode.pipe(Effect.flatMap((service) => service.info)),
    ),
  );
  ipcMain.handle(channels.getOpenCodeInstallFolder, () => openCodeBinaryDirectory);
  ipcMain.handle(channels.getStudioMcpStatus, () =>
    openCodeRuntime.runPromise(StudioMcpBroker.pipe(Effect.flatMap((broker) => broker.status))),
  );
  ipcMain.handle(channels.getVersion, () => runMain(Effect.sync(() => app.getVersion())));
  ipcMain.handle(channels.getInstructionFiles, () =>
    findInstructionFiles({
      globalConfigDirectory: openCodeConfigDirectory(),
      home: app.getPath("home"),
    }),
  );
  ipcMain.handle(channels.readInstructions, () => readInstructions(openCodeConfigDirectory()));
  ipcMain.handle(channels.saveInstructions, (_event, text: unknown) =>
    Schema.decodeUnknownPromise(Schema.String)(text).then((value) =>
      saveInstructions(openCodeConfigDirectory(), value),
    ),
  );
  ipcMain.handle(channels.loadConfig, () => runMain(loadConfig));
  ipcMain.handle(channels.patchConfig, (_event, patch: unknown) => runMain(patchConfig(patch)));
  ipcMain.handle(channels.setSystemPrompt, (_event, input: unknown) =>
    runMain(
      Effect.gen(function* () {
        const systemPrompt = yield* Schema.decodeUnknown(Schema.NullOr(Schema.String))(input).pipe(
          Effect.mapError(
            (cause) => new DesktopMainError({ message: "System prompt is invalid", cause }),
          ),
        );
        yield* patchConfig({ systemPrompt });
        // OpenCode reads this file. The renderer reloads it once this has written the change.
        const configFile = join(openCodeConfigDirectory(), "opencode.json");
        yield* Effect.tryPromise({
          try: async () =>
            writeFile(configFile, withSystemPrompt(await readFile(configFile, "utf8"), systemPrompt)),
          catch: (cause) =>
            new DesktopMainError({ message: "Failed to apply the system prompt", cause }),
        });
      }),
    ),
  );
  // A newer read replaces one still running, so a closed place doesn't keep Studio busy.
  let explorerTreeRead: AbortController | null = null;
  ipcMain.handle(channels.syncExplorerTree, (event, studioId: unknown, request: unknown) =>
    queryStudio(async (callTool) => {
      const id = await Schema.decodeUnknownPromise(StudioKeySchema)(studioId);
      const options = await Schema.decodeUnknownPromise(ExplorerSyncRequestSchema)(request);
      explorerTreeRead?.abort();
      const read = new AbortController();
      explorerTreeRead = read;
      return syncExplorerTree(callTool, id, {
        ...options,
        signal: read.signal,
        onUpdate: (update) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(channels.explorerTreeUpdate, { studioId: id, ...update });
          }
        },
      });
    }),
  );
  ipcMain.handle(channels.getExplorerNodeDetails, (_event, studioId: unknown, request: unknown) =>
    queryStudio(async (callTool) => {
      const details = await inspectExplorerNode(
        callTool,
        await Schema.decodeUnknownPromise(StudioKeySchema)(studioId),
        await Schema.decodeUnknownPromise(ExplorerDetailsRequestSchema)(request),
      );
      return details && Schema.decodeUnknownPromise(ExplorerNodeDetailsSchema)(details);
    }),
  );
  ipcMain.handle(channels.editExplorerObject, (_event, studioId: unknown, edit: unknown) =>
    queryStudio(async (callTool) =>
      editExplorerObject(
        callTool,
        await Schema.decodeUnknownPromise(StudioKeySchema)(studioId),
        await Schema.decodeUnknownPromise(ExplorerEditSchema)(edit),
      ),
    ),
  );
  ipcMain.handle(channels.discoverStudioTargets, () =>
    queryStudio(async (callTool) =>
      Schema.decodeUnknownPromise(StudioTargetDiscoverySchema)(await discoverStudioTargets(callTool)),
    ),
  );
  ipcMain.handle(channels.selectStudioTarget, (_event, input: unknown) =>
    queryStudio(async (callTool) =>
      Schema.decodeUnknownPromise(StudioTargetSelectionSchema)(
        await selectStudioTarget(callTool, await Schema.decodeUnknownPromise(StudioKeySchema)(input)),
      ),
    ),
  );
  ipcMain.handle(channels.openUrl, (_event, rawUrl: string) =>
    runMain(
      parseExternalUrl(rawUrl).pipe(
        Effect.flatMap(openLink),
      ),
    ),
  );
  ipcMain.handle(channels.openNotificationSettings, () => {
    const url = notificationSettingsUrl(process.platform, "ai.bloxbot.desktop");
    return url ? shell.openExternal(url) : undefined;
  });
  ipcMain.handle(channels.showSystemNotification, (_event, input: unknown) =>
    runMain(
      Schema.decodeUnknown(SystemNotificationSchema)(input).pipe(
        Effect.mapError(
          (cause) => new DesktopMainError({ message: "System notification is invalid", cause }),
        ),
        Effect.flatMap((notification) =>
          Effect.tryPromise({
            try: () => showSystemNotification(notification),
            catch: (cause) =>
              new DesktopMainError({ message: "Failed to show a system notification", cause }),
          }),
        ),
      ),
    ),
  );
  ipcMain.handle(channels.checkForUpdate, () =>
    runMain(
      Effect.gen(function* () {
        if (!app.isPackaged) return null;
        const result = yield* Effect.tryPromise({
          try: () => autoUpdater.checkForUpdates(),
          catch: (cause) =>
            new DesktopMainError({ message: "Failed to check for updates", cause }),
        });
        if (!result) return null;
        const body =
          typeof result.updateInfo.releaseNotes === "string" ? result.updateInfo.releaseNotes : null;
        return { version: result.updateInfo.version, body };
      }),
    ),
  );
  ipcMain.handle(channels.installUpdate, () =>
    runMain(
      Effect.gen(function* () {
        if (!app.isPackaged) {
          return yield* Effect.fail(
            new DesktopMainError({ message: "Updates are only available in packaged builds" }),
          );
        }
        yield* Effect.tryPromise({
          try: () => autoUpdater.downloadUpdate(),
          catch: (cause) =>
            new DesktopMainError({ message: "Failed to download the update", cause }),
        });
        yield* Effect.sync(() => autoUpdater.quitAndInstall());
      }),
    ),
  );
  // Kept here rather than on the page, since leaving Settings shouldn't stop or lose a setup.
  let blenderSetup: AbortController | null = null;
  let blenderProgress: BlenderSetupProgress | null = null;
  const applyBlenderToConfig = (blender: ReturnType<typeof blenderMcpServerConfig> | null) =>
    Effect.gen(function* () {
      const { systemPrompt } = yield* loadConfig;
      yield* Effect.tryPromise({
        try: async () => {
          const configFile = join(openCodeConfigDirectory(), "opencode.json");
          await writeFile(
            configFile,
            withBlender(await readFile(configFile, "utf8"), blender, systemPrompt),
          );
        },
        catch: (cause) =>
          new DesktopMainError({ message: "Failed to apply Blender's settings", cause }),
      });
    });
  ipcMain.handle(channels.getBlenderToolsState, () =>
    blenderSetup
      ? { state: "installing", progress: blenderProgress }
      : getBlenderToolsState(blenderToolsRoot()),
  );
  ipcMain.handle(channels.installBlenderTools, (event) => {
    if (blenderSetup) return undefined;
    const setup = new AbortController();
    blenderSetup = setup;
    blenderProgress = null;
    return runMain(
      installBlenderTools({
        root: blenderToolsRoot(),
        fetch: (url, init) => net.fetch(url, init),
        signal: setup.signal,
        onProgress: (progress) => {
          blenderProgress = progress;
          if (!event.sender.isDestroyed()) {
            event.sender.send(channels.blenderSetupProgress, progress);
          }
        },
      }).pipe(
        // The page reads the reason from the message, as errors lose everything else crossing over.
        Effect.mapError(
          (error) =>
            new DesktopMainError({
              message: `${error.message} (reason: ${error.reason})`,
              cause: error.cause,
            }),
        ),
        Effect.andThen(applyBlenderToConfig(blenderMcpServerConfig(blenderToolsRoot()))),
        Effect.ensuring(
          Effect.sync(() => {
            blenderSetup = null;
          }),
        ),
      ),
    );
  });
  ipcMain.handle(channels.cancelBlenderTools, () => blenderSetup?.abort());
  ipcMain.handle(channels.openBlender, () =>
    runMain(
      Effect.try({
        try: () => openBlender(blenderToolsRoot()),
        catch: (cause) => new DesktopMainError({ message: "Couldn't open Blender", cause }),
      }),
    ),
  );
  ipcMain.handle(channels.removeBlenderTools, () =>
    runMain(
      Effect.gen(function* () {
        const state = yield* Effect.promise(() => getBlenderToolsState(blenderToolsRoot()));
        if (state.state === "ready" && state.running) {
          return yield* Effect.fail(new DesktopMainError({ message: "Close Blender first" }));
        }
        yield* applyBlenderToConfig(null);
        yield* Effect.tryPromise({
          try: () => removeBlenderTools(blenderToolsRoot()),
          catch: (cause) => new DesktopMainError({ message: "Couldn't remove Blender", cause }),
        });
      }),
    ),
  );
  const robloxKeyFile = () => join(app.getPath("userData"), "roblox-upload-key.json");
  const sentModels = () => sentModelsFile(app.getPath("userData"));
  const uploadsInFlight = new Map<string, Promise<ModelUploadResult>>();
  ipcMain.handle(channels.getRobloxUploadState, () =>
    getRobloxUploadState(robloxKeyFile(), safeStorage),
  );
  ipcMain.handle(channels.checkRobloxKey, async (_event, key: unknown, studioKey: unknown) => {
    const decoded = await Schema.decodeUnknownPromise(RobloxKeySchema)(key);
    const check = await inspectRobloxKey(decoded);
    if (check.result !== "checked") return check;
    try {
      // Settings can be open with no chat, and one open Studio can only be the one that's meant.
      const targets = typeof studioKey === "string" ? [] : (await queryStudio(discoverStudioTargets)).targets;
      const studio = typeof studioKey === "string" ? studioKey : targets[0]?.key;
      if (!studio || targets.length > 1) return check;
      const id = await queryStudio((callTool) => readStudioAccount(callTool, studio));
      return { ...check, studio: { id, name: id === check.ownerId ? check.ownerName : await robloxUserName(id) } };
    } catch {
      // Studio isn't open to ask, so the upload checks this again.
      return check;
    }
  });
  ipcMain.handle(channels.saveRobloxKey, async (_event, key: unknown) => {
    const decoded = await Schema.decodeUnknownPromise(RobloxKeySchema)(key);
    const check = await inspectRobloxKey(decoded);
    if (check.result !== "checked" || !keyIsUsable(check)) throw new Error("This key can't upload");
    await saveRobloxKey(robloxKeyFile(), safeStorage, decoded, {
      ownerId: check.ownerId,
      ownerName: check.ownerName,
    });
  });
  ipcMain.handle(channels.forgetRobloxKey, () => forgetRobloxKey(robloxKeyFile()));
  ipcMain.handle(channels.readModelFile, async (_event, url: unknown) => {
    const file = await readModelFile(await Schema.decodeUnknownPromise(Schema.String)(url));
    if (!file) return null;
    return {
      name: file.name,
      fileName: file.fileName,
      path: file.path,
      data: file.bytes,
      kind: file.contentType === "model/fbx" ? "fbx" : "glb",
      sizeBytes: file.bytes.byteLength,
      sent: await readSentModel(sentModels(), file.hash),
    };
  });
  ipcMain.handle(channels.uploadModelToPlace, async (event, url: unknown, studioKey: unknown) => {
    const decodedUrl = await Schema.decodeUnknownPromise(Schema.String)(url);
    const studio = await Schema.decodeUnknownPromise(StudioKeySchema)(studioKey);
    // A second click, or a second card for the same file, joins the upload that's running.
    const running = uploadsInFlight.get(decodedUrl);
    if (running) return running;
    const upload = sendModelToPlace(decodedUrl, {
      keyFile: robloxKeyFile(),
      sentFile: sentModels(),
      encryption: safeStorage,
      studioAccount: () => queryStudio((callTool) => readStudioAccount(callTool, studio)),
      insert: (assetId, name) =>
        queryStudio((callTool) => insertUploadedModel(callTool, studio, assetId, name)),
      onStep: (step) => {
        if (!event.sender.isDestroyed()) event.sender.send(channels.modelUploadStep, decodedUrl, step);
      },
    }).finally(() => uploadsInFlight.delete(decodedUrl));
    uploadsInFlight.set(decodedUrl, upload);
    return upload;
  });
  ipcMain.handle(channels.relaunch, () =>
    runMain(
      Effect.sync(() => {
        app.relaunch();
        app.quit();
      }),
    ),
  );
});

function createWindow(): Effect.Effect<void, DesktopMainError> {
  return Effect.gen(function* () {
    const window = yield* Effect.try({
      try: () =>
        new BrowserWindow({
          title: "BloxBot",
          width: 920,
          height: 600,
          minWidth: 520,
          minHeight: 400,
          backgroundColor: "#ffffff",
          titleBarStyle: "hiddenInset",
          show: false,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: join(currentDirectory, "..", "preload", "preload.mjs"),
            sandbox: true,
          },
        }),
      catch: (cause) => new DesktopMainError({ message: "Failed to create app window", cause }),
    });

    yield* Effect.sync(() => {
      mainWindow = window;
      window.webContents.setUserAgent(
        `${window.webContents.getUserAgent()} BloxBot/${app.getVersion()}`,
      );
      window.webContents.setWindowOpenHandler(({ url }) => {
        Effect.runFork(
          parseExternalUrl(url).pipe(
            Effect.flatMap(openLink),
            Effect.catchAll(Effect.logWarning),
          ),
        );
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        const currentUrl = window.webContents.getURL();
        const shouldBlock = Effect.runSync(
          Effect.try({
            try: () => Boolean(currentUrl && new URL(url).origin !== new URL(currentUrl).origin),
            catch: () => true,
          }).pipe(Effect.catchAll(() => Effect.succeed(true))),
        );
        if (shouldBlock) event.preventDefault();
      });
      window.once("ready-to-show", () => Effect.runSync(Effect.sync(() => window.show())));
      window.on("closed", () =>
        Effect.runSync(
          Effect.sync(() => {
            if (mainWindow === window) mainWindow = null;
          }),
        ),
      );
    });

    yield* Effect.tryPromise({
      try: () =>
        process.env.VITE_DEV_SERVER_URL
          ? window.loadURL(process.env.VITE_DEV_SERVER_URL)
          : window.loadFile(join(currentDirectory, "..", "..", "dist", "index.html")),
      catch: (cause) => new DesktopMainError({ message: "Failed to load the app window", cause }),
    });
  });
}

const registerAppLifecycle = Effect.sync(() => {
  // Windows drops notifications from an app without this. It matches appId in electron-builder.yml.
  if (process.platform === "win32") app.setAppUserModelId("ai.bloxbot.desktop");

  app.on("window-all-closed", () =>
    Effect.runSync(
      Effect.sync(() => {
        handleLastWindowClosed(process.platform, {
          hideDock: () => app.dock?.hide(),
          quit: () => app.quit(),
        });
      }),
    ),
  );

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    Effect.runFork(
      Effect.tryPromise({
        try: () => openCodeRuntime.dispose(),
        catch: (cause) =>
          new DesktopMainError({ message: "Failed to stop the OpenCode runtime", cause }),
      }).pipe(
        Effect.catchAll(Effect.logError),
        Effect.ensuring(
          Effect.sync(() => {
            quitting = true;
            app.quit();
          }),
        ),
      ),
    );
  });
});

Effect.runFork(
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = true;
    });
    yield* registerAppLifecycle;
    yield* Effect.tryPromise({
      try: () => app.whenReady(),
      catch: (cause) => new DesktopMainError({ message: "Electron failed to become ready", cause }),
    });
    yield* registerIpcHandlers;
    yield* Effect.sync(() => Menu.setApplicationMenu(null));
    yield* createWindow();
    yield* Effect.sync(() =>
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          Effect.runFork(
            createWindow().pipe(
              Effect.tapError((error) =>
                Effect.sync(() => reportMainError("main_create_window", error)),
              ),
              Effect.catchAll(Effect.logError),
            ),
          );
        }
      }),
    );
  }).pipe(
    Effect.tapError((error) => Effect.sync(() => reportMainError("main_startup", error))),
    Effect.catchAll(Effect.logError),
  ),
);
