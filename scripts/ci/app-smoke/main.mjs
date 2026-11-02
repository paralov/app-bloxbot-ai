// Starts the built app in a throwaway home: it installs OpenCode, starts it and connects the same
// way a user's first launch does. Passes once the signed-in app is on screen.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow } from "electron";

const TIMEOUT_MS = 5 * 60 * 1000;
const home = mkdtempSync(join(tmpdir(), "bloxbot-smoke-"));
mkdirSync(join(home, "userData"));
app.setPath("home", home);
app.setPath("userData", join(home, "userData"));

let lastText = "";
const finish = (code, message) => {
  console.log(`[smoke] ${message}`);
  process.exit(code);
};
const started = Date.now();
setInterval(async () => {
  const [window] = BrowserWindow.getAllWindows();
  if (window) {
    lastText = await window.webContents
      .executeJavaScript("document.body.innerText")
      .catch(() => lastText);
  }
  if (lastText.includes("Settings")) finish(0, "BloxBot started and reached the app");
  if (Date.now() - started > TIMEOUT_MS) finish(1, `Timed out. On screen:\n${lastText}`);
}, 1000);

await import(pathToFileURL(join(process.cwd(), "dist-electron/main/main.js")).href);
