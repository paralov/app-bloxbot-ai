import { Schema } from "effect";

export const GENERATED_PROGRAM_VERSION = 1 as const;

export const GeneratedProgramContractSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  version: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  inputSchemaVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
  outputSchemaVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)),
});

export const GeneratedProgramEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(GENERATED_PROGRAM_VERSION),
  contract: GeneratedProgramContractSchema,
  source: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100_000)),
});

export type GeneratedProgramEnvelope = typeof GeneratedProgramEnvelopeSchema.Type;

export const GeneratedProgramArtifactSchema = Schema.Struct({
  cacheKey: Schema.String.pipe(Schema.minLength(64), Schema.maxLength(64)),
  contract: GeneratedProgramContractSchema,
  compiledSource: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(250_000)),
});

export type GeneratedProgramArtifact = typeof GeneratedProgramArtifactSchema.Type;

export const GeneratedProgramInvocationSchema = Schema.Struct({
  artifact: GeneratedProgramArtifactSchema,
  input: Schema.Unknown,
});

export type GeneratedProgramInvocation = typeof GeneratedProgramInvocationSchema.Type;

export const GeneratedProgramResultSchema = Schema.Struct({
  contract: GeneratedProgramContractSchema,
  value: Schema.Unknown,
});

export type GeneratedProgramResult = typeof GeneratedProgramResultSchema.Type;
