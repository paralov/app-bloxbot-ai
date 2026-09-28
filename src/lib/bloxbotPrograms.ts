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

export interface ResolvedBloxBotPrograms {
  /** "published" when any program came from a newer published manifest. */
  source: "published" | "builtin";
  sequence: number;
  explorer: ExplorerProgramEnvelope;
  targets: StudioTargetProgramEnvelopes;
}

const BUILTIN: ResolvedBloxBotPrograms = {
  source: "builtin",
  sequence: BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence,
  explorer: BUILTIN_EXPLORER_PROGRAM,
  targets: BUILTIN_STUDIO_TARGET_PROGRAMS,
};

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
  if (!published || published.sequence <= BUILTIN.sequence) return BUILTIN;
  const usable = usableBloxBotPrograms(published);
  const explorer = usable["explorer-snapshot"];
  const discovery = usable["studio-target-discovery"];
  const selection = usable["studio-target-selection"];
  if (!explorer && !discovery && !selection) return BUILTIN;
  return {
    source: "published",
    sequence: published.sequence,
    explorer: explorer
      ? Schema.decodeUnknownSync(ExplorerProgramEnvelopeSchema)(explorer)
      : BUILTIN.explorer,
    targets: Schema.decodeUnknownSync(StudioTargetProgramEnvelopesSchema)({
      discovery: discovery ?? BUILTIN.targets.discovery,
      selection: selection ?? BUILTIN.targets.selection,
    }),
  };
}
