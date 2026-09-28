import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import {
  BLOXBOT_PROGRAM_NAMES,
  type BloxBotProgramManifest,
  BloxBotProgramManifestSchema,
  type BloxBotProgramName,
  type BloxBotProgramSources,
  buildBloxBotProgramManifest,
} from "../../src/lib/bloxbotProgramManifest";

export const PROGRAMS_DIR = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  "bloxbot-programs",
);
export const MANIFEST_PATH = join(PROGRAMS_DIR, "manifest.json");

/** Reads a program file with LF line endings, whatever the checkout used. */
export async function readProgramFile(path: string): Promise<string> {
  return (await readFile(join(PROGRAMS_DIR, path), "utf8")).replace(/\r\n/g, "\n");
}

export async function readSources(): Promise<BloxBotProgramSources> {
  const programs = {} as Record<BloxBotProgramName, string>;
  for (const name of BLOXBOT_PROGRAM_NAMES) programs[name] = await readProgramFile(`${name}.ts`);
  return { lib: await readProgramFile("lib/mcp.ts"), programs };
}

export async function readShippedManifest(): Promise<BloxBotProgramManifest | null> {
  try {
    return Schema.decodeUnknownSync(BloxBotProgramManifestSchema)(
      JSON.parse(await readProgramFile("manifest.json")),
    );
  } catch {
    return null;
  }
}

export function samePrograms(a: { programs: unknown }, b: { programs: unknown }): boolean {
  return JSON.stringify(a.programs) === JSON.stringify(b.programs);
}

/**
 * The manifest for the current sources. The sequence only moves when they
 * change, and then past the published one too, so programs an app ships are
 * never outranked by an older published copy (for example after a revert).
 */
export async function expectedManifest(publishedSequence = 0): Promise<BloxBotProgramManifest> {
  const sources = await readSources();
  const shipped = await readShippedManifest();
  const unchanged = validated(buildBloxBotProgramManifest(sources, shipped?.sequence ?? 1));
  if (shipped && samePrograms(shipped, unchanged)) return shipped;
  return validated(
    buildBloxBotProgramManifest(sources, Math.max(shipped?.sequence ?? 0, publishedSequence) + 1),
  );
}

/**
 * Checks the built manifest against the schema the app decodes it with, so a
 * program that only fails once the shared helpers are prepended (the envelope
 * size limit) is caught here rather than shipped or published.
 */
export function validated(manifest: BloxBotProgramManifest): BloxBotProgramManifest {
  try {
    return Schema.decodeUnknownSync(BloxBotProgramManifestSchema)(manifest);
  } catch (error) {
    throw new Error(
      `The built manifest would be rejected by the app: ${error instanceof Error ? error.message : error}`,
    );
  }
}
