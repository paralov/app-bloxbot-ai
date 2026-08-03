import { rename, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { Data, Effect, Layer, ManagedRuntime, Schema } from "effect";

import {
  type AppConfig,
  AppConfigPatchSchema,
  AppConfigSchema,
  DEFAULT_APP_CONFIG,
  type OpenCodeStartupProgress,
} from "../src/types/desktop";
import { ExplorerProgramEnvelopeSchema, ExplorerSnapshotSchema } from "../src/lib/explorer";
import { GeneratedProgramArtifactSchema } from "../src/types/generatedProgram";
import {
  StudioTargetDiscoverySchema,
  StudioTargetProgramEnvelopesSchema,
  StudioTargetProgramsSchema,
  StudioTargetSelectionSchema,
} from "../src/types/studioTarget";
import { handleLastWindowClosed } from "./appLifecycle";
import { channels } from "./channels";
import { makeOpenCodeLayer, OpenCode } from "./services/OpenCode";
import {
  GeneratedProgramRuntime,
  GeneratedProgramRuntimeLive,
} from "./services/GeneratedProgramRuntime";
import { makeStudioMcpBrokerLayer } from "./services/StudioMcpBroker";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfig: AppConfig = DEFAULT_APP_CONFIG;
const configMutex = Effect.unsafeMakeSemaphore(1);

function configPath(): string {
  return join(app.getPath("userData"), "bloxbot-store.json");
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;

class DesktopMainError extends Data.TaggedError("DesktopMainError")<{
  message: string;
  cause?: unknown;
}> {}

const studioMcpBrokerLayer = makeStudioMcpBrokerLayer({
  workspace: join(app.getPath("home"), "BloxBot"),
  localAppData: process.env.LOCALAPPDATA,
});

const openCodeRuntime = ManagedRuntime.make(
  Layer.merge(
    makeOpenCodeLayer({
      binaryCacheDirectory: join(app.getPath("userData"), "opencode"),
      workspace: join(app.getPath("home"), "BloxBot"),
      onStartupProgress: (progress: OpenCodeStartupProgress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channels.openCodeStartupProgress, progress);
        }
      },
    }),
    GeneratedProgramRuntimeLive.pipe(Layer.provide(studioMcpBrokerLayer)),
  ).pipe(Layer.provide(studioMcpBrokerLayer)),
);

const expectedContract = (name: string) => ({
  name,
  version: "1",
  inputSchemaVersion: "1",
  outputSchemaVersion: "1",
});

function requireContract(contract: { name: string; version: string; inputSchemaVersion: string; outputSchemaVersion: string }, name: string) {
  const expected = expectedContract(name);
  if (JSON.stringify(contract) !== JSON.stringify(expected)) {
    return Effect.fail(new DesktopMainError({ message: `Generated program contract ${name} is invalid` }));
  }
  return Effect.void;
}

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
      new DesktopMainError({ message: "Only HTTP and HTTPS links can be opened", cause }),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:" || url.protocol === "http:"
        ? Effect.succeed(url)
        : Effect.fail(
            new DesktopMainError({ message: "Only HTTP and HTTPS links can be opened" }),
          ),
    ),
  );
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

const AUTOUPDATE_DISABLE_VALUES = new Set(["1", "true", "yes"]);

function isAutoUpdateDisabled(): boolean {
  const value = process.env.BLOXBOT_DISABLE_AUTOUPDATE?.trim().toLowerCase() ?? "";
  return AUTOUPDATE_DISABLE_VALUES.has(value);
}

const runMain = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const registerIpcHandlers = Effect.sync(() => {
  ipcMain.handle(channels.compileExplorerProgram, (_event, input: unknown) =>
    openCodeRuntime.runPromise(
      Effect.gen(function* () {
        const program = yield* Schema.decodeUnknown(ExplorerProgramEnvelopeSchema)(input);
        const runtime = yield* GeneratedProgramRuntime;
        return yield* runtime.compile(program);
      }),
    ),
  );
  ipcMain.handle(channels.getOpenCodeInfo, () =>
    openCodeRuntime.runPromise(
      OpenCode.pipe(Effect.flatMap((service) => service.info)),
    ),
  );
  ipcMain.handle(channels.getVersion, () => runMain(Effect.sync(() => app.getVersion())));
  ipcMain.handle(channels.loadConfig, () => runMain(loadConfig));
  ipcMain.handle(channels.patchConfig, (_event, patch: unknown) => runMain(patchConfig(patch)));
  ipcMain.handle(channels.installStudioTargetPrograms, (_event, input: unknown) =>
    openCodeRuntime.runPromise(
      Effect.gen(function* () {
        const envelopes = yield* Schema.decodeUnknown(StudioTargetProgramEnvelopesSchema)(input);
        yield* requireContract(envelopes.discovery.contract, "studio-target-discovery");
        yield* requireContract(envelopes.selection.contract, "studio-target-selection");
        const runtime = yield* GeneratedProgramRuntime;
        const [discoveryArtifact, selectionArtifact] = yield* Effect.all([
          runtime.compile(envelopes.discovery),
          runtime.compile(envelopes.selection),
        ], { concurrency: "unbounded" });
        return yield* Schema.decodeUnknown(StudioTargetProgramsSchema)({
          discovery: { envelope: envelopes.discovery, artifact: discoveryArtifact },
          selection: { envelope: envelopes.selection, artifact: selectionArtifact },
        });
      }),
    ),
  );
  ipcMain.handle(channels.discoverStudioTargets, (_event, input: unknown) =>
    openCodeRuntime.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("[studio-target] discovery requested");
        const programs = yield* Schema.decodeUnknown(StudioTargetProgramsSchema)(input);
        yield* requireContract(programs.discovery.artifact.contract, "studio-target-discovery");
        const runtime = yield* GeneratedProgramRuntime;
        const result = yield* runtime.invoke({ artifact: programs.discovery.artifact, input: {} });
        const discovery = yield* Schema.decodeUnknown(StudioTargetDiscoverySchema)(result.value);
        yield* Effect.logInfo(
          `[studio-target] discovery completed targets=${discovery.targets.length} selected=${discovery.selectedKey !== null}`,
        );
        return discovery;
      }),
    ),
  );
  ipcMain.handle(channels.selectStudioTarget, (_event, input: unknown, targetKey: unknown) =>
    openCodeRuntime.runPromise(
      Effect.gen(function* () {
        const programs = yield* Schema.decodeUnknown(StudioTargetProgramsSchema)(input);
        const key = yield* Schema.decodeUnknown(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)))(targetKey);
        yield* requireContract(programs.selection.artifact.contract, "studio-target-selection");
        const runtime = yield* GeneratedProgramRuntime;
        const result = yield* runtime.invoke({ artifact: programs.selection.artifact, input: { targetKey: key } });
        return yield* Schema.decodeUnknown(StudioTargetSelectionSchema)(result.value);
      }),
    ),
  );
  ipcMain.handle(channels.openUrl, (_event, rawUrl: string) =>
    runMain(
      parseExternalUrl(rawUrl).pipe(
        Effect.flatMap((url) =>
          Effect.tryPromise({
            try: () => shell.openExternal(url.href),
            catch: (cause) => new DesktopMainError({ message: "Failed to open URL", cause }),
          }),
        ),
      ),
    ),
  );
  ipcMain.handle(channels.checkForUpdate, () =>
    runMain(
      Effect.gen(function* () {
        if (!app.isPackaged) return null;
        if (isAutoUpdateDisabled()) return null;
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
        if (isAutoUpdateDisabled()) {
          return yield* Effect.fail(
            new DesktopMainError({ message: "Auto-update is disabled via BLOXBOT_DISABLE_AUTOUPDATE" }),
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
  ipcMain.handle(channels.invokeExplorerProgram, (_event, input: unknown) =>
    openCodeRuntime.runPromise(
      Effect.gen(function* () {
        const artifact = yield* Schema.decodeUnknown(GeneratedProgramArtifactSchema)(input);
        if (
          artifact.contract.name !== "explorer-snapshot" ||
          artifact.contract.outputSchemaVersion !== "explorer-snapshot-v1"
        ) {
          return yield* Effect.fail(
            new DesktopMainError({ message: "Explorer program contract is invalid" }),
          );
        }
        const runtime = yield* GeneratedProgramRuntime;
        const result = yield* runtime.invoke({ artifact, input: null });
        return yield* Schema.decodeUnknown(ExplorerSnapshotSchema)(result.value).pipe(
          Effect.mapError(
            (cause) => new DesktopMainError({ message: "Explorer output is invalid", cause }),
          ),
        );
      }).pipe(
        Effect.tapErrorCause((cause) =>
          Effect.logError(`[explorer] invocation failed: ${String(cause)}`),
        ),
      ),
    ),
  );
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
            Effect.flatMap((externalUrl) =>
              Effect.tryPromise({
                try: () => shell.openExternal(externalUrl.href),
                catch: (cause) =>
                  new DesktopMainError({ message: "Failed to open URL", cause }),
              }),
            ),
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
          Effect.runFork(createWindow().pipe(Effect.catchAll(Effect.logError)));
        }
      }),
    );
  }).pipe(Effect.catchAll(Effect.logError)),
);
