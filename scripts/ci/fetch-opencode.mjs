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
