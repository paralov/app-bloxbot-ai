import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Schema } from "effect";

import {
  type BloxBotProgramManifest,
  BloxBotProgramManifestSchema,
} from "../../src/lib/bloxbotProgramManifest";
import { verifyBloxBotProgramManifest } from "../bloxbotProgramSignature";

// Published as prerelease assets on a rolling release, so electron-updater (which
// follows the repository's latest release) never mistakes it for an app update.
const RELEASE_URL = "https://github.com/paralov/app-bloxbot-ai/releases/download/bloxbot-programs";
export const BLOXBOT_PROGRAMS_MANIFEST_URL = `${RELEASE_URL}/manifest.json`;
export const BLOXBOT_PROGRAMS_SIGNATURE_URL = `${RELEASE_URL}/manifest.json.sig`;

const FETCH_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 1_000_000;

export interface BloxBotProgramStoreOptions {
  /** Where the last verified manifest and its signature are kept. */
  directory: string;
  fetch?: typeof fetch;
  publicKey?: string;
  log?: (message: string) => void;
}

export interface BloxBotProgramStore {
  /** The newest verified manifest, if any has been downloaded or cached. */
  current(): BloxBotProgramManifest | null;
  /** Loads the cached copy; call once at startup. */
  load(): Promise<void>;
  /** Downloads the published manifest and keeps it if it verifies and isn't older. */
  refresh(): Promise<"updated" | "unchanged" | "rejected" | "unavailable">;
}

export function createBloxBotProgramStore(options: BloxBotProgramStoreOptions): BloxBotProgramStore {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const manifestPath = join(options.directory, "manifest.json");
  const signaturePath = join(options.directory, "manifest.json.sig");
  let current: BloxBotProgramManifest | null = null;

  function accept(raw: string, signature: string): BloxBotProgramManifest | null {
    if (!verifyBloxBotProgramManifest(raw, signature, options.publicKey)) return null;
    try {
      return Schema.decodeUnknownSync(BloxBotProgramManifestSchema)(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async function download(url: string): Promise<string | null> {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/octet-stream" },
      });
      if (!response.ok) return null;
      const text = await response.text();
      return text.length <= MAX_MANIFEST_BYTES ? text : null;
    } catch {
      return null;
    }
  }

  return {
    current: () => current,

    async load() {
      try {
        const [raw, signature] = await Promise.all([
          readFile(manifestPath, "utf8"),
          readFile(signaturePath, "utf8"),
        ]);
        // Re-verify on every load, so a tampered cache is never trusted.
        current = accept(raw, signature);
        if (!current) log("[bloxbot-programs] ignoring cached manifest that failed verification");
      } catch {
        current = null;
      }
    },

    async refresh() {
      const [raw, signature] = await Promise.all([
        download(BLOXBOT_PROGRAMS_MANIFEST_URL),
        download(BLOXBOT_PROGRAMS_SIGNATURE_URL),
      ]);
      if (raw === null || signature === null) return "unavailable";
      const manifest = accept(raw, signature);
      if (!manifest) {
        log("[bloxbot-programs] rejected a published manifest that failed verification");
        return "rejected";
      }
      // Never go back to an older manifest, even a validly signed one.
      if (current && manifest.sequence < current.sequence) {
        log(`[bloxbot-programs] rejected sequence ${manifest.sequence} < ${current.sequence}`);
        return "rejected";
      }
      if (current && manifest.sequence === current.sequence) return "unchanged";
      await mkdir(options.directory, { recursive: true });
      // Write the signature first and swap the manifest in atomically, so a
      // crash leaves either the old pair or a pair that fails verification.
      await writeFile(signaturePath, signature, "utf8");
      await writeFile(`${manifestPath}.tmp`, raw, "utf8");
      await rename(`${manifestPath}.tmp`, manifestPath);
      current = manifest;
      log(`[bloxbot-programs] using published sequence ${manifest.sequence}`);
      return "updated";
    },
  };
}
