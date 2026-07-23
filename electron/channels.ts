export const channels = {
  checkForUpdate: "app:check-for-update",
  getOpenCodeInfo: "opencode:get-info",
  openCodeStartupProgress: "opencode:startup-progress",
  isStudioConnected: "studio:is-connected",
  getVersion: "app:get-version",
  installUpdate: "app:install-update",
  loadConfig: "config:load",
  openUrl: "app:open-url",
  patchConfig: "config:patch",
  relaunch: "app:relaunch",
} as const;
