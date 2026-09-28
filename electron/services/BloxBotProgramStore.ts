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
const MAX_DOWNLOAD_BYTES = 1_000_000;

export interface BloxBotProgramStoreOptions {
  /** Where the last verified manifest and its signature are kept. */
  directory: string;
  fetch?: typeof fetch;
  publicKey?: string;
  log?: (message: string) => void;
}

export type BloxBotProgramRefresh = "updated" | "unchanged" | "rejected" | "unavailable";

export interface BloxBotProgramStore {
  /** The newest verified manifest, if any has been downloaded or cached. */
  current(): BloxBotProgramManifest | null;
  /** Loads the cached copy; call once at startup. */
  load(): Promise<void>;
  /** Downloads the published manifest and keeps it if it verifies and isn't older. Never throws. */
  refresh(): Promise<BloxBotProgramRefresh>;
}

// The manifest and its signature are cached together in one file, swapped in
// atomically, so a crash can never leave a manifest paired with the wrong signature.
const CachedSchema = Schema.Struct({ manifest: Schema.String, signature: Schema.String });

export function createBloxBotProgramStore(options: BloxBotProgramStoreOptions): BloxBotProgramStore {
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const cachePath = join(options.directory, "cache.json");
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
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_DOWNLOAD_BYTES || !response.body) return null;
      // Count bytes as they arrive, so an oversized body is never buffered whole.
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return new TextDecoder().decode(Buffer.concat(chunks));
    } catch {
      return null;
    }
  }

  async function save(raw: string, signature: string) {
    await mkdir(options.directory, { recursive: true });
    const temporary = `${cachePath}.tmp`;
    await writeFile(temporary, JSON.stringify({ manifest: raw, signature }), "utf8");
    await rename(temporary, cachePath);
  }

  return {
    current: () => current,

    async load() {
      try {
        const cached = Schema.decodeUnknownSync(CachedSchema)(
          JSON.parse(await readFile(cachePath, "utf8")),
        );
        // Re-verify on every load, so a tampered cache is never trusted.
        current = accept(cached.manifest, cached.signature);
        if (!current) log("[bloxbot-programs] ignoring cached manifest that failed verification");
      } catch {
        current = null;
      }
    },

    async refresh() {
      try {
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
        await save(raw, signature);
        current = manifest;
        log(`[bloxbot-programs] using published sequence ${manifest.sequence}`);
        return "updated";
      } catch (error) {
        // A failed cache write (read-only or full disk) leaves the app on what it has.
        log(`[bloxbot-programs] refresh failed: ${error instanceof Error ? error.message : error}`);
        return "unavailable";
      }
    },
  };
}
