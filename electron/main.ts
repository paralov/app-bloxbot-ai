import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { Effect, ManagedRuntime } from "effect";

import type { AppConfig } from "../src/types/desktop";
import { shouldQuitAfterLastWindowCloses } from "./appLifecycle";
import { channels } from "./channels";
import { makeOpenCodeLayer, OpenCode } from "./services/OpenCode";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const defaultConfig: AppConfig = { lastModel: null, hiddenModels: [] };

let mainWindow: BrowserWindow | null = null;
let quitting = false;

const openCodeRuntime = ManagedRuntime.make(
  makeOpenCodeLayer({
    binaryCacheDirectory: join(app.getPath("userData"), "opencode"),
    workspace: join(app.getPath("home"), "BloxBot"),
  }),
);

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function loadConfig(): Promise<AppConfig> {
  try {
    const contents = await readFile(join(app.getPath("userData"), "bloxbot-store.json"), "utf8");
    return { ...defaultConfig, ...JSON.parse(contents) };
  } catch {
    return defaultConfig;
  }
}

async function patchConfig(patch: Partial<AppConfig>): Promise<void> {
  const next = { ...(await loadConfig()), ...patch };
  await writeFile(join(app.getPath("userData"), "bloxbot-store.json"), JSON.stringify(next, null, 2));
}

function registerIpcHandlers(): void {
  ipcMain.handle(channels.getOpenCodeInfo, () =>
    openCodeRuntime.runPromise(
      OpenCode.pipe(Effect.flatMap((service) => service.info)),
    ),
  );
  ipcMain.handle(channels.getVersion, () => app.getVersion());
  ipcMain.handle(channels.loadConfig, loadConfig);
  ipcMain.handle(channels.patchConfig, (_event, patch: Partial<AppConfig>) => patchConfig(patch));
  ipcMain.handle(channels.openUrl, async (_event, url: string) => {
    if (!isSafeExternalUrl(url)) throw new Error("Only HTTP and HTTPS links can be opened");
    await shell.openExternal(url);
  });
  ipcMain.handle(channels.checkForUpdate, async () => {
    if (!app.isPackaged) return null;
    const result = await autoUpdater.checkForUpdates();
    if (!result) return null;
    const body = typeof result.updateInfo.releaseNotes === "string" ? result.updateInfo.releaseNotes : null;
    return { version: result.updateInfo.version, body };
  });
  ipcMain.handle(channels.installUpdate, async () => {
    if (!app.isPackaged) throw new Error("Updates are only available in packaged builds");
    await autoUpdater.downloadUpdate();
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle(channels.relaunch, () => {
    app.relaunch();
    app.quit();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: "BloxBot",
    width: 800,
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
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (currentUrl && new URL(url).origin !== new URL(currentUrl).origin) {
      event.preventDefault();
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(currentDirectory, "..", "..", "dist", "index.html"));
  }
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

app.whenReady().then(() => {
  registerIpcHandlers();
  Menu.setApplicationMenu(null);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (shouldQuitAfterLastWindowCloses(process.platform, app.isPackaged)) app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void openCodeRuntime.dispose().finally(() => {
    quitting = true;
    app.quit();
  });
});
