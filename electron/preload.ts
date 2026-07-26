import { contextBridge, ipcRenderer } from "electron";

import type { AppConfig, DesktopApi, OpenCodeStartupProgress } from "../src/types/desktop";
import { channels } from "./channels";

const api: DesktopApi = {
  getOpenCodeInfo: () => ipcRenderer.invoke(channels.getOpenCodeInfo),
  onOpenCodeStartupProgress: (listener) => {
    const handleProgress = (_event: Electron.IpcRendererEvent, progress: OpenCodeStartupProgress) =>
      listener(progress);
    ipcRenderer.on(channels.openCodeStartupProgress, handleProgress);
    return () => ipcRenderer.removeListener(channels.openCodeStartupProgress, handleProgress);
  },
  getVersion: () => ipcRenderer.invoke(channels.getVersion),
  openUrl: (url) => ipcRenderer.invoke(channels.openUrl, url),
  loadConfig: () => ipcRenderer.invoke(channels.loadConfig),
  patchConfig: (patch: Partial<AppConfig>) => ipcRenderer.invoke(channels.patchConfig, patch),
  checkForUpdate: () => ipcRenderer.invoke(channels.checkForUpdate),
  installUpdate: () => ipcRenderer.invoke(channels.installUpdate),
  relaunch: () => ipcRenderer.invoke(channels.relaunch),
  discoverStudioTargets: () => ipcRenderer.invoke(channels.discoverStudioTargets),
  selectStudioTarget: (targetKey) => ipcRenderer.invoke(channels.selectStudioTarget, targetKey),
};

contextBridge.exposeInMainWorld("bloxbot", api);
