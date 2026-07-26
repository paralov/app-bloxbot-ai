import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Schema } from "effect";

export const ExplorerFieldSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});

export type ExplorerField = typeof ExplorerFieldSchema.Type;

export const ExplorerNodeSchema = Schema.Struct({
  name: Schema.String,
  className: Schema.String,
  path: Schema.String,
  hasChildren: Schema.Boolean,
  properties: Schema.Array(ExplorerFieldSchema),
  attributes: Schema.Array(ExplorerFieldSchema),
  children: Schema.Array(Schema.suspend((): Schema.Schema<ExplorerNode> => ExplorerNodeSchema)),
});

export interface ExplorerNode {
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly properties: readonly ExplorerField[];
  readonly attributes: readonly ExplorerField[];
  readonly children: readonly ExplorerNode[];
}

export const ExplorerSnapshotSchema = Schema.Struct({
  placeName: Schema.String,
  capturedAt: Schema.String,
  roots: Schema.Array(ExplorerNodeSchema),
});

export type ExplorerSnapshot = typeof ExplorerSnapshotSchema.Type;

export const ExplorerCollectionSchema = Schema.Struct({
  collector: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(12_000)),
  snapshot: ExplorerSnapshotSchema,
});

export type ExplorerCollection = typeof ExplorerCollectionSchema.Type;

const FIELD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "value"],
  properties: { name: { type: "string" }, value: { type: "string" } },
} as const;

const NODE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "className", "path", "hasChildren", "properties", "attributes", "children"],
  properties: {
    name: { type: "string" },
    className: { type: "string" },
    path: { type: "string" },
    hasChildren: { type: "boolean" },
    properties: { type: "array", items: FIELD_JSON_SCHEMA, maxItems: 16 },
    attributes: { type: "array", items: FIELD_JSON_SCHEMA, maxItems: 24 },
    children: { type: "array", items: { $ref: "#/$defs/node" } },
  },
} as const;

const SNAPSHOT_PROPERTIES = {
  placeName: { type: "string" },
  capturedAt: { type: "string" },
  roots: { type: "array", items: { $ref: "#/$defs/node" } },
} as const;

export const EXPLORER_COLLECTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["collector", "snapshot"],
  properties: {
    collector: { type: "string", minLength: 1, maxLength: 12_000 },
    snapshot: {
      type: "object",
      additionalProperties: false,
      required: ["placeName", "capturedAt", "roots"],
      properties: SNAPSHOT_PROPERTIES,
    },
  },
  $defs: { node: NODE_JSON_SCHEMA },
} as const;

export const EXPLORER_SNAPSHOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["placeName", "capturedAt", "roots"],
  properties: SNAPSHOT_PROPERTIES,
  $defs: { node: NODE_JSON_SCHEMA },
} as const;

const INITIAL_SYSTEM_PROMPT = `You are the private data provider for BloxBot's Explorer panel.
Discover the currently available capabilities and design a deterministic, read-only collector that can be rerun verbatim to inspect the connected Roblox Studio place.
The collector may be a small program or precise execution instructions. It must contain everything a future agent needs to rerun it without rediscovering or replanning, and it must never modify the place.
Run the collector now and return both the exact collector and a snapshot. Do not rely on earlier conversation context.
For every object include a compact set of useful, readable properties and all available attributes. Stringify values safely.
Paths are dot-separated human-readable hints, not durable identifiers. Keep children in Studio order.
Return only the requested structured output.`;

const REPLAY_SYSTEM_PROMPT = `You are the private data provider for BloxBot's Explorer panel.
Rerun the supplied collector exactly as written against the currently connected place. Do not rediscover capabilities, redesign the collector, or modify the place.
Return a fresh snapshot only. Paths are hints, not durable identifiers. Return only the requested structured output.`;

interface ExplorerModel {
  providerID: string;
  modelID: string;
}

async function withPrivateSession<T>(
  client: OpencodeClient,
  run: (sessionID: string) => Promise<T>,
): Promise<T> {
  const created = await client.session.create(
    {
      title: "BloxBot Explorer sync",
      metadata: { bloxbotHidden: true, purpose: "explorer" },
    },
    { throwOnError: true },
  );
  const sessionID = created.data.id;

  try {
    return await run(sessionID);
  } finally {
    await client.session.delete({ sessionID }, { throwOnError: true }).catch(() => undefined);
  }
}

export async function generateExplorerCollection(
  client: OpencodeClient,
  model?: ExplorerModel,
  agent?: string | null,
): Promise<ExplorerCollection> {
  return withPrivateSession(client, async (sessionID) => {
    const response = await client.session.prompt(
      {
        sessionID,
        model,
        agent: agent ?? undefined,
        system: INITIAL_SYSTEM_PROMPT,
        format: { type: "json_schema", schema: EXPLORER_COLLECTION_OUTPUT_SCHEMA, retryCount: 2 },
        parts: [
          {
            type: "text",
            text: "Discover a safe read-only collection method, retain it as the collector, and run it for the initial Explorer snapshot.",
          },
        ],
      },
      { throwOnError: true },
    );

    return Effect.runPromise(
      Schema.decodeUnknown(ExplorerCollectionSchema)(response.data.info.structured),
    );
  });
}

export async function replayExplorerCollector(
  client: OpencodeClient,
  collector: string,
  model?: ExplorerModel,
  agent?: string | null,
): Promise<ExplorerSnapshot> {
  return withPrivateSession(client, async (sessionID) => {
    const response = await client.session.prompt(
      {
        sessionID,
        model,
        agent: agent ?? undefined,
        system: REPLAY_SYSTEM_PROMPT,
        format: { type: "json_schema", schema: EXPLORER_SNAPSHOT_OUTPUT_SCHEMA, retryCount: 1 },
        parts: [
          {
            type: "text",
            text: `Rerun this exact read-only collector:\n\n<collector>\n${collector}\n</collector>`,
          },
        ],
      },
      { throwOnError: true },
    );

    return Effect.runPromise(
      Schema.decodeUnknown(ExplorerSnapshotSchema)(response.data.info.structured),
    );
  });
}

export function createExplorerReference(node: ExplorerNode): string {
  return (
    `Regarding the ${node.className} at \`${node.path}\`: ` +
    "treat this path only as a hint. Rediscover the object in the connected place and verify its identity and current state immediately before taking any action."
  );
}
