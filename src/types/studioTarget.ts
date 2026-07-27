import { Schema } from "effect";
import { GeneratedProgramArtifactSchema, GeneratedProgramEnvelopeSchema } from "./generatedProgram";

export const StudioTargetSchema = Schema.Struct({
  key: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  detail: Schema.NullOr(Schema.String.pipe(Schema.maxLength(512))),
});

export type StudioTarget = typeof StudioTargetSchema.Type;

export const StudioTargetDiscoverySchema = Schema.Struct({
  targets: Schema.Array(StudioTargetSchema),
  selectedKey: Schema.NullOr(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512))),
});

export type StudioTargetDiscovery = typeof StudioTargetDiscoverySchema.Type;

export const StudioTargetSelectionSchema = Schema.Struct({
  selected: StudioTargetSchema,
  verified: Schema.Boolean,
});

export type StudioTargetSelection = typeof StudioTargetSelectionSchema.Type;

export const StudioTargetProgramSchema = Schema.Struct({
  envelope: GeneratedProgramEnvelopeSchema,
  artifact: GeneratedProgramArtifactSchema,
});

export const StudioTargetProgramsSchema = Schema.Struct({
  discovery: StudioTargetProgramSchema,
  selection: StudioTargetProgramSchema,
});

export type StudioTargetPrograms = typeof StudioTargetProgramsSchema.Type;

export const StudioTargetProgramEnvelopesSchema = Schema.Struct({
  discovery: GeneratedProgramEnvelopeSchema,
  selection: GeneratedProgramEnvelopeSchema,
});

export type StudioTargetProgramEnvelopes = typeof StudioTargetProgramEnvelopesSchema.Type;
