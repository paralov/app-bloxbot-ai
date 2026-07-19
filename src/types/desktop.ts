export interface AppConfig {
  lastModel: string | null;
  hiddenModels: string[];
}

export interface OpenCodeInfo {
  authorization: string;
  port: number;
  workspace: string;
}

export interface UpdateInfo {
  version: string;
  body: string | null;
}

export interface DesktopApi {
  getOpenCodeInfo(): Promise<OpenCodeInfo>;
  getVersion(): Promise<string>;
  openUrl(url: string): Promise<void>;
  loadConfig(): Promise<AppConfig>;
  patchConfig(patch: Partial<AppConfig>): Promise<void>;
  checkForUpdate(): Promise<UpdateInfo | null>;
  installUpdate(): Promise<void>;
  relaunch(): Promise<void>;
}
