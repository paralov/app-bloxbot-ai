export function shouldQuitAfterLastWindowCloses(
  platform: NodeJS.Platform,
  isPackaged: boolean,
): boolean {
  return platform !== "darwin" || !isPackaged;
}
