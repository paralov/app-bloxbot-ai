import { Schema } from "effect";

import {
  GENERATED_PROGRAM_VERSION,
  type GeneratedProgramEnvelope,
  GeneratedProgramEnvelopeSchema,
} from "../types/generatedProgram";

// BloxBot programs are the small TypeScript programs BloxBot runs against the
// Studio MCP (Explorer, Studio discovery and selection). Their sources live in
// bloxbot-programs/, are built into bloxbot-programs/manifest.json (shipped with
// the app as the built-in fallback), and are published signed so BloxBot can
// pick up fixes for Studio MCP changes without an app release.

export const BLOXBOT_PROGRAM_MANIFEST_FORMAT = 1 as const;

/**
 * The program contracts this app version can run. A published program is only
 * used when its contract matches exactly, so a program written for a newer
 * contract never runs in an app that doesn't understand its output.
 */
export const BLOXBOT_PROGRAM_CONTRACTS = {
  "explorer-snapshot": {
    name: "explorer-snapshot",
    version: "1",
    inputSchemaVersion: "explorer-input-v1",
    outputSchemaVersion: "explorer-snapshot-v1",
  },
  "studio-target-discovery": {
    name: "studio-target-discovery",
    version: "1",
    inputSchemaVersion: "1",
    outputSchemaVersion: "1",
  },
  "studio-target-selection": {
    name: "studio-target-selection",
    version: "1",
    inputSchemaVersion: "1",
    outputSchemaVersion: "1",
  },
} as const;

export type BloxBotProgramName = keyof typeof BLOXBOT_PROGRAM_CONTRACTS;

export const BLOXBOT_PROGRAM_NAMES = Object.keys(BLOXBOT_PROGRAM_CONTRACTS) as BloxBotProgramName[];

/**
 * Studio MCP tools a BloxBot program may call. All read-only: a program that is
 * compromised or simply wrong can inspect the place but never change it.
 */
export const BLOXBOT_PROGRAM_TOOLS: Record<BloxBotProgramName, readonly string[]> = {
  "explorer-snapshot": [
    "list_roblox_studios",
    "get_studio_state",
    "search_game_tree",
    "inspect_instance",
  ],
  "studio-target-discovery": ["list_roblox_studios"],
  "studio-target-selection": ["list_roblox_studios"],
};

export const BloxBotProgramManifestSchema = Schema.Struct({
  format: Schema.Literal(BLOXBOT_PROGRAM_MANIFEST_FORMAT),
  /** Increases with every published change; the app never goes back to a lower one. */
  sequence: Schema.Number.pipe(Schema.int(), Schema.positive()),
  programs: Schema.Record({ key: Schema.String, value: GeneratedProgramEnvelopeSchema }),
});

export type BloxBotProgramManifest = typeof BloxBotProgramManifestSchema.Type;

export interface BloxBotProgramSources {
  /** Helpers shared by every program, prepended to each source. */
  lib: string;
  programs: Record<BloxBotProgramName, string>;
}

/** Builds the manifest the app ships and the release workflow signs. */
export function buildBloxBotProgramManifest(
  sources: BloxBotProgramSources,
  sequence: number,
): BloxBotProgramManifest {
  const programs: Record<string, GeneratedProgramEnvelope> = {};
  for (const name of BLOXBOT_PROGRAM_NAMES) {
    programs[name] = {
      version: GENERATED_PROGRAM_VERSION,
      contract: { ...BLOXBOT_PROGRAM_CONTRACTS[name] },
      source: `${sources.lib.trimEnd()}\n\n${sources.programs[name].trim()}\n`,
    };
  }
  return { format: BLOXBOT_PROGRAM_MANIFEST_FORMAT, sequence, programs };
}

/** Same bytes every time for the same manifest, so signatures are stable. */
export function serializeBloxBotProgramManifest(manifest: BloxBotProgramManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * The programs in a manifest this app can run: known names whose contract
 * matches exactly. Anything else is ignored, and the caller falls back.
 */
export function usableBloxBotPrograms(
  manifest: BloxBotProgramManifest,
): Partial<Record<BloxBotProgramName, GeneratedProgramEnvelope>> {
  const usable: Partial<Record<BloxBotProgramName, GeneratedProgramEnvelope>> = {};
  for (const name of BLOXBOT_PROGRAM_NAMES) {
    const envelope = manifest.programs[name];
    if (!envelope) continue;
    const expected = BLOXBOT_PROGRAM_CONTRACTS[name];
    const actual = envelope.contract;
    if (
      actual.name === expected.name &&
      actual.version === expected.version &&
      actual.inputSchemaVersion === expected.inputSchemaVersion &&
      actual.outputSchemaVersion === expected.outputSchemaVersion
    ) {
      usable[name] = envelope;
    }
  }
  return usable;
}

/** Tools a program with this contract name may call; unknown contracts get none. */
export function allowedBloxBotProgramTools(contractName: string): readonly string[] {
  return contractName in BLOXBOT_PROGRAM_TOOLS
    ? BLOXBOT_PROGRAM_TOOLS[contractName as BloxBotProgramName]
    : [];
}
