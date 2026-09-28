import { Schema } from "effect";
import {
  type BloxBotProgramManifest,
  BloxBotProgramManifestSchema,
} from "@/lib/bloxbotProgramManifest";
import { type ExplorerProgramEnvelope, ExplorerProgramEnvelopeSchema } from "@/lib/explorer";
import {
  type StudioTargetProgramEnvelopes,
  StudioTargetProgramEnvelopesSchema,
} from "@/types/studioTarget";

import manifest from "../../bloxbot-programs/manifest.json";

// The BloxBot programs shipped with this app version, built from bloxbot-programs/
// (`pnpm bloxbot-programs build`). BloxBot prefers a newer published copy when
// one is available and falls back to these.
export const BUILTIN_BLOXBOT_PROGRAM_MANIFEST: BloxBotProgramManifest = Schema.decodeUnknownSync(
  BloxBotProgramManifestSchema,
)(manifest);

export const BUILTIN_EXPLORER_PROGRAM: ExplorerProgramEnvelope = Schema.decodeUnknownSync(
  ExplorerProgramEnvelopeSchema,
)(BUILTIN_BLOXBOT_PROGRAM_MANIFEST.programs["explorer-snapshot"]);

export const BUILTIN_STUDIO_TARGET_PROGRAMS: StudioTargetProgramEnvelopes =
  Schema.decodeUnknownSync(StudioTargetProgramEnvelopesSchema)({
    discovery: BUILTIN_BLOXBOT_PROGRAM_MANIFEST.programs["studio-target-discovery"],
    selection: BUILTIN_BLOXBOT_PROGRAM_MANIFEST.programs["studio-target-selection"],
  });
