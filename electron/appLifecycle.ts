interface LastWindowCloseActions {
  readonly hideDock: () => void;
  readonly quit: () => void;
}

export function handleLastWindowClosed(
  platform: NodeJS.Platform,
  actions: LastWindowCloseActions,
): void {
  if (platform === "darwin") actions.hideDock();
  actions.quit();
}
