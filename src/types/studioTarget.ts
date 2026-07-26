import { Schema } from "effect";

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
