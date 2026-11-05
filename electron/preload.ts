import { contextBridge, ipcRenderer } from "electron";

import type {
  BlenderSetupProgress,
  ModelUploadStep,
  AppConfig,
  DesktopApi,
  MainErrorReport,
  OpenCodeStartupProgress,
} from "../src/types/desktop";
import type { ExplorerTreeUpdate } from "../src/lib/explorer";
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
  getBlenderToolsState: () => ipcRenderer.invoke(channels.getBlenderToolsState),
  installBlenderTools: () => ipcRenderer.invoke(channels.installBlenderTools),
  cancelBlenderTools: () => ipcRenderer.invoke(channels.cancelBlenderTools),
  openBlender: () => ipcRenderer.invoke(channels.openBlender),
  removeBlenderTools: () => ipcRenderer.invoke(channels.removeBlenderTools),
  getUploadAccess: (studioKey, modelUrl) =>
    ipcRenderer.invoke(channels.getUploadAccess, studioKey, modelUrl),
  readModelFile: (url) => ipcRenderer.invoke(channels.readModelFile, url),
  uploadModelToPlace: (url, studioKey, hash, addOnly) =>
    ipcRenderer.invoke(channels.uploadModelToPlace, url, studioKey, hash, addOnly === true),
  onModelUploadStep: (listener) => {
    const handler = (_event: unknown, url: string, step: ModelUploadStep) => listener(url, step);
    ipcRenderer.on(channels.modelUploadStep, handler);
    return () => ipcRenderer.removeListener(channels.modelUploadStep, handler);
  },
  onBlenderSetupProgress: (listener) => {
    const handler = (_event: unknown, progress: BlenderSetupProgress) => listener(progress);
    ipcRenderer.on(channels.blenderSetupProgress, handler);
    return () => ipcRenderer.removeListener(channels.blenderSetupProgress, handler);
  },
  showSystemNotification: (notification) =>
    ipcRenderer.invoke(channels.showSystemNotification, notification),
  openNotificationSettings: () => ipcRenderer.invoke(channels.openNotificationSettings),
  onSystemNotificationClick: (listener) => {
    const handleClick = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
    ipcRenderer.on(channels.systemNotificationClicked, handleClick);
    return () => ipcRenderer.removeListener(channels.systemNotificationClicked, handleClick);
  },
  syncExplorerTree: (studioId, request) =>
    ipcRenderer.invoke(channels.syncExplorerTree, studioId, request),
  onExplorerTreeUpdate: (listener) => {
    const handleUpdate = (_event: Electron.IpcRendererEvent, update: ExplorerTreeUpdate) =>
      listener(update);
    ipcRenderer.on(channels.explorerTreeUpdate, handleUpdate);
    return () => ipcRenderer.removeListener(channels.explorerTreeUpdate, handleUpdate);
  },
  readInstructions: () => ipcRenderer.invoke(channels.readInstructions),
  saveInstructions: (text) => ipcRenderer.invoke(channels.saveInstructions, text),
  getExplorerNodeDetails: (studioId, request) =>
    ipcRenderer.invoke(channels.getExplorerNodeDetails, studioId, request),
  editExplorerObject: (studioId, edit) =>
    ipcRenderer.invoke(channels.editExplorerObject, studioId, edit),
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
