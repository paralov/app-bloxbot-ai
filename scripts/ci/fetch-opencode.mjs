// Downloads the pinned OpenCode release for this platform and points the live tests at it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extract from "extract-zip";
import { x as untar } from "tar";

const pinned = readFileSync("electron/services/openCodePinnedRelease.ts", "utf8");
const tag = /const TAG = "(v[^"]+)"/.exec(pinned)?.[1];
const key = `${process.platform}-${process.arch}`;
const entry = new RegExp(
  `"${key}": \\{\\s*assetName: "([^"]+)",[^}]*?sha256: "([0-9a-f]{64})"`,
  "s",
).exec(pinned);
if (!tag || !entry) throw new Error(`No pinned OpenCode release for ${key}`);
const [, assetName, sha256] = entry;

const directory = mkdtempSync(join(tmpdir(), "opencode-"));
execFileSync("gh", ["release", "download", tag, "-R", "anomalyco/opencode", "-p", assetName, "-D", directory], {
  stdio: "inherit",
});
const archive = join(directory, assetName);
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (digest !== sha256) throw new Error(`${assetName} doesn't match its pinned SHA-256`);

const bin = join(directory, "bin");
mkdirSync(bin);
if (assetName.endsWith(".zip")) await extract(archive, { dir: bin });
else await untar({ file: archive, cwd: bin });

const executable = join(bin, process.platform === "win32" ? "opencode.exe" : "opencode");
appendFileSync(process.env.GITHUB_ENV, `OPENCODE_LIVE_BIN=${executable}\n`);
console.log(`OpenCode ${tag}: ${executable}`);

// The last release BloxBot shipped on OpenCode 1, for the upgrade test.
const V1_TAG = "v1.18.33";
const V1_RELEASES = {
  "darwin-arm64": ["opencode-darwin-arm64.zip", "24b12873e605b3db3387cb355f43ba7451cd6065c180d8c188663337d2eeb553"],
  "win32-x64": ["opencode-windows-x64.zip", "cc827fda2e32502373c5de25a4b78471766b99881d12a441ae5b9fcff39c5780"],
  "linux-x64": ["opencode-linux-x64.tar.gz", "e546123213ae47909a4268692aa4b94950d011afe9cac9938753a2194f1c16d5"],
};
const v1 = V1_RELEASES[key];
if (v1) {
  const v1Directory = mkdtempSync(join(tmpdir(), "opencode-v1-"));
  execFileSync("gh", ["release", "download", V1_TAG, "-R", "anomalyco/opencode", "-p", v1[0], "-D", v1Directory], {
    stdio: "inherit",
  });
  const v1Archive = join(v1Directory, v1[0]);
  if (createHash("sha256").update(readFileSync(v1Archive)).digest("hex") !== v1[1]) {
    throw new Error(`${v1[0]} doesn't match its pinned SHA-256`);
  }
  const v1Bin = join(v1Directory, "bin");
  mkdirSync(v1Bin);
  if (v1[0].endsWith(".zip")) await extract(v1Archive, { dir: v1Bin });
  else await untar({ file: v1Archive, cwd: v1Bin });
  const v1Executable = join(v1Bin, process.platform === "win32" ? "opencode.exe" : "opencode");
  appendFileSync(process.env.GITHUB_ENV, `OPENCODE_LIVE_V1_BIN=${v1Executable}\n`);
}
