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

export async function readSources(): Promise<BloxBotProgramSources> {
  const programs = {} as Record<BloxBotProgramName, string>;
  for (const name of BLOXBOT_PROGRAM_NAMES) {
    programs[name] = await readFile(join(PROGRAMS_DIR, `${name}.ts`), "utf8");
  }
  return { lib: await readFile(join(PROGRAMS_DIR, "lib", "mcp.ts"), "utf8"), programs };
}

export async function readShippedManifest(): Promise<BloxBotProgramManifest | null> {
  try {
    return Schema.decodeUnknownSync(BloxBotProgramManifestSchema)(
      JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
    );
  } catch {
    return null;
  }
}

export function samePrograms(a: BloxBotProgramManifest, b: BloxBotProgramManifest): boolean {
  return JSON.stringify(a.programs) === JSON.stringify(b.programs);
}

/** The manifest for the current sources; the sequence only moves when they change. */
export async function expectedManifest(): Promise<BloxBotProgramManifest> {
  const sources = await readSources();
  const shipped = await readShippedManifest();
  const unchanged = buildBloxBotProgramManifest(sources, shipped?.sequence ?? 1);
  if (shipped && samePrograms(shipped, unchanged)) return shipped;
  return buildBloxBotProgramManifest(sources, (shipped?.sequence ?? 0) + 1);
}
