import { contextBridge, ipcRenderer } from "electron";

import type {
  AppConfig,
  DesktopApi,
  MainErrorReport,
  OpenCodeStartupProgress,
} from "../src/types/desktop";
import { channels } from "./channels";

const api: DesktopApi = {
  getOpenCodeInfo: () => ipcRenderer.invoke(channels.getOpenCodeInfo),
  getOpenCodeInstallFolder: () => ipcRenderer.invoke(channels.getOpenCodeInstallFolder),
  getStudioMcpStatus: () => ipcRenderer.invoke(channels.getStudioMcpStatus),
  onOpenCodeStartupProgress: (listener) => {
    const handleProgress = (_event: Electron.IpcRendererEvent, progress: OpenCodeStartupProgress) =>
      listener(progress);
    ipcRenderer.on(channels.openCodeStartupProgress, handleProgress);
    return () => ipcRenderer.removeListener(channels.openCodeStartupProgress, handleProgress);
  },
  getVersion: () => ipcRenderer.invoke(channels.getVersion),
  getInstructionFiles: () => ipcRenderer.invoke(channels.getInstructionFiles),
  openUrl: (url) => ipcRenderer.invoke(channels.openUrl, url),
  loadConfig: () => ipcRenderer.invoke(channels.loadConfig),
  patchConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke(channels.patchConfig, patch),
  setSystemPrompt: (systemPrompt) => ipcRenderer.invoke(channels.setSystemPrompt, systemPrompt),
  checkForUpdate: () => ipcRenderer.invoke(channels.checkForUpdate),
  installUpdate: () => ipcRenderer.invoke(channels.installUpdate),
  relaunch: () => ipcRenderer.invoke(channels.relaunch),
  showSystemNotification: (notification) =>
    ipcRenderer.invoke(channels.showSystemNotification, notification),
  onSystemNotificationClick: (listener) => {
    const handleClick = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
    ipcRenderer.on(channels.systemNotificationClicked, handleClick);
    return () => ipcRenderer.removeListener(channels.systemNotificationClicked, handleClick);
  },
  getExplorerSnapshot: (studioId) => ipcRenderer.invoke(channels.getExplorerSnapshot, studioId),
  getExplorerNodeDetails: (studioId, path) =>
    ipcRenderer.invoke(channels.getExplorerNodeDetails, studioId, path),
  discoverStudioTargets: () => ipcRenderer.invoke(channels.discoverStudioTargets),
  selectStudioTarget: (targetKey) => ipcRenderer.invoke(channels.selectStudioTarget, targetKey),
  onMainError: (listener) => {
    const handleError = (_event: Electron.IpcRendererEvent, report: MainErrorReport) =>
      listener(report);
    ipcRenderer.on(channels.mainError, handleError);
    // Errors from before the window was listening are buffered in main until this arrives.
    ipcRenderer.send(channels.mainErrorReady);
    return () => ipcRenderer.removeListener(channels.mainError, handleError);
  },
};

contextBridge.exposeInMainWorld("bloxbot", api);
