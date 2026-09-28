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
 * Studio MCP tools each program is known to use. Beyond these, a program may
 * call any tool Studio itself marks read-only (see isBloxBotProgramToolAllowed),
 * so a renamed or new read-only tool works without an app release.
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

/** The MCP tool annotations Studio sends with its tool list. */
export interface StudioToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

/** Whether a program may call a tool without asking Studio for its annotations. */
export function isKnownBloxBotProgramTool(contractName: string, toolName: string): boolean {
  return (
    contractName in BLOXBOT_PROGRAM_TOOLS &&
    BLOXBOT_PROGRAM_TOOLS[contractName as BloxBotProgramName].includes(toolName)
  );
}

/**
 * Whether Studio says a tool only reads the place: read-only and explicitly
 * closed-world (so not http_get, which reaches the internet). MCP treats a
 * missing openWorldHint as open-world, so an unlabelled tool doesn't qualify.
 */
export function isReadOnlyStudioTool(annotations?: StudioToolAnnotations): boolean {
  return annotations?.readOnlyHint === true && annotations.openWorldHint === false;
}

/**
 * Whether a program may call a Studio tool, whoever wrote the program. Programs
 * only read: they get the tools they're known to use, plus any tool Studio marks
 * read-only. Programs for contracts this app doesn't know get nothing.
 */
export function isBloxBotProgramToolAllowed(
  contractName: string,
  toolName: string,
  annotations?: StudioToolAnnotations,
): boolean {
  if (!(contractName in BLOXBOT_PROGRAM_TOOLS)) return false;
  return isKnownBloxBotProgramTool(contractName, toolName) || isReadOnlyStudioTool(annotations);
}

/**
 * The name OpenCode knows the Studio MCP server by. OpenCode shows the model
 * Studio's tools as `roblox-studio_<tool>`, so a model-written program may use
 * that form.
 */
export const STUDIO_MCP_SERVER_NAME = "roblox-studio";

const STUDIO_TOOL_PREFIX = `${STUDIO_MCP_SERVER_NAME}_`;

/** Studio's own name for a tool, without the prefix OpenCode adds. */
export function studioToolName(name: string): string {
  return name.startsWith(STUDIO_TOOL_PREFIX) ? name.slice(STUDIO_TOOL_PREFIX.length) : name;
}

/**
 * The tools Studio lists that a program may call: the ones it is known to use
 * plus any Studio marks read-only. The brief and the Explorer generation prompt
 * both list these.
 */
export function allowedBloxBotProgramTools<
  T extends { name: string; annotations?: StudioToolAnnotations },
>(program: BloxBotProgramName, tools: readonly T[]): T[] {
  return tools.filter((tool) => isBloxBotProgramToolAllowed(program, tool.name, tool.annotations));
}
