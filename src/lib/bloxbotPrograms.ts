import { Schema } from "effect";
import { usableBloxBotPrograms } from "@/lib/bloxbotProgramManifest";
import {
  BUILTIN_BLOXBOT_PROGRAM_MANIFEST,
  BUILTIN_EXPLORER_PROGRAM,
  BUILTIN_STUDIO_TARGET_PROGRAMS,
} from "@/lib/builtinBloxBotPrograms";
import { desktop } from "@/lib/desktop";
import { type ExplorerProgramEnvelope, ExplorerProgramEnvelopeSchema } from "@/lib/explorer";
import {
  type StudioTargetProgramEnvelopes,
  StudioTargetProgramEnvelopesSchema,
} from "@/types/studioTarget";

/** Where a program came from, recorded in analytics so broken ones are traceable. */
export interface BloxBotProgramOrigin {
  source: "published" | "builtin";
  sequence: number;
}

export interface ResolvedBloxBotPrograms {
  explorer: BloxBotProgramOrigin & { program: ExplorerProgramEnvelope };
  targets: BloxBotProgramOrigin & { programs: StudioTargetProgramEnvelopes };
}

const BUILTIN_ORIGIN: BloxBotProgramOrigin = {
  source: "builtin",
  sequence: BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence,
};

export const BUILTIN_BLOXBOT_PROGRAMS: ResolvedBloxBotPrograms = {
  explorer: { ...BUILTIN_ORIGIN, program: BUILTIN_EXPLORER_PROGRAM },
  targets: { ...BUILTIN_ORIGIN, programs: BUILTIN_STUDIO_TARGET_PROGRAMS },
};

/** A published program that doesn't fit the app's schema is treated as missing. */
function decodeOrNull<A, I>(schema: Schema.Schema<A, I>, value: unknown): A | null {
  if (value === undefined) return null;
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return null;
  }
}

/**
 * The BloxBot programs to run: a published copy when it is newer than the one
 * this app shipped with, program by program, falling back to the built-in
 * programs for anything missing or written for a different contract.
 */
export async function resolveBloxBotPrograms(): Promise<ResolvedBloxBotPrograms> {
  let published: Awaited<ReturnType<typeof desktop.getBloxBotPrograms>> = null;
  try {
    published = await desktop.getBloxBotPrograms();
  } catch {
    // Anything wrong with the published copy just means the built-in programs.
  }
  if (!published || published.sequence <= BUILTIN_ORIGIN.sequence) return BUILTIN_BLOXBOT_PROGRAMS;

  const origin: BloxBotProgramOrigin = { source: "published", sequence: published.sequence };
  const usable = usableBloxBotPrograms(published);
  const explorer = decodeOrNull(ExplorerProgramEnvelopeSchema, usable["explorer-snapshot"]);
  // Discovery and selection work as a pair, so they come from one place.
  const targets =
    usable["studio-target-discovery"] && usable["studio-target-selection"]
      ? decodeOrNull(StudioTargetProgramEnvelopesSchema, {
          discovery: usable["studio-target-discovery"],
          selection: usable["studio-target-selection"],
        })
      : null;
  return {
    explorer: explorer ? { ...origin, program: explorer } : BUILTIN_BLOXBOT_PROGRAMS.explorer,
    targets: targets ? { ...origin, programs: targets } : BUILTIN_BLOXBOT_PROGRAMS.targets,
  };
}
