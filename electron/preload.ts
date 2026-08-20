import { contextBridge, ipcRenderer } from "electron";

import type { AppConfig, DesktopApi, OpenCodeStartupProgress } from "../src/types/desktop";
import { channels } from "./channels";

const api: DesktopApi = {
  compileExplorerProgram: (program) =>
    ipcRenderer.invoke(channels.compileExplorerProgram, program),
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
  invokeExplorerProgram: (artifact, studioId) =>
    ipcRenderer.invoke(channels.invokeExplorerProgram, artifact, studioId),
  relaunch: () => ipcRenderer.invoke(channels.relaunch),
  installStudioTargetPrograms: (envelopes) =>
    ipcRenderer.invoke(channels.installStudioTargetPrograms, envelopes),
  discoverStudioTargets: (programs) =>
    ipcRenderer.invoke(channels.discoverStudioTargets, programs),
  selectStudioTarget: (programs, targetKey) =>
    ipcRenderer.invoke(channels.selectStudioTarget, programs, targetKey),
};

contextBridge.exposeInMainWorld("bloxbot", api);
