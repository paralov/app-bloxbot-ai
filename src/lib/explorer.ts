import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Schema } from "effect";

export const ExplorerNodeSchema = Schema.Struct({
  name: Schema.String,
  className: Schema.String,
  path: Schema.String,
  hasChildren: Schema.Boolean,
  children: Schema.Array(Schema.suspend((): Schema.Schema<ExplorerNode> => ExplorerNodeSchema)),
});

export interface ExplorerNode {
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly children: readonly ExplorerNode[];
}

export const ExplorerSnapshotSchema = Schema.Struct({
  placeName: Schema.String,
  capturedAt: Schema.String,
  roots: Schema.Array(ExplorerNodeSchema),
});

export type ExplorerSnapshot = typeof ExplorerSnapshotSchema.Type;

export const EXPLORER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["placeName", "capturedAt", "roots"],
  properties: {
    placeName: { type: "string" },
    capturedAt: { type: "string" },
    roots: {
      type: "array",
      items: { $ref: "#/$defs/node" },
    },
  },
  $defs: {
    node: {
      type: "object",
      additionalProperties: false,
      required: ["name", "className", "path", "hasChildren", "children"],
      properties: {
        name: { type: "string" },
        className: { type: "string" },
        path: { type: "string" },
        hasChildren: { type: "boolean" },
        children: { type: "array", items: { $ref: "#/$defs/node" } },
      },
    },
  },
} as const;

const EXPLORER_SYSTEM_PROMPT = `You are the private data provider for BloxBot's Explorer panel.
Inspect the currently connected Roblox Studio place using the capabilities available to you.
Return a fresh instance hierarchy, including common top-level services and their descendants.
Do not change the place. Do not rely on earlier conversation context. Discover the active place now.
Paths are dot-separated human-readable hints, not durable identifiers. Keep each node's children in Studio order.
Set hasChildren true when the object has descendants, even if a safety limit prevents returning all of them.
Return only the requested structured output.`;

export async function loadExplorerSnapshot(
  client: OpencodeClient,
  model?: { providerID: string; modelID: string },
  agent?: string | null,
): Promise<ExplorerSnapshot> {
  const created = await client.session.create(
    {
      title: "BloxBot Explorer refresh",
      metadata: { bloxbotHidden: true, purpose: "explorer" },
    },
    { throwOnError: true },
  );
  const sessionID = created.data.id;

  try {
    const response = await client.session.prompt(
      {
        sessionID,
        model,
        agent: agent ?? undefined,
        system: EXPLORER_SYSTEM_PROMPT,
        format: { type: "json_schema", schema: EXPLORER_OUTPUT_SCHEMA, retryCount: 2 },
        parts: [
          {
            type: "text",
            text: "Read the connected place and produce the Explorer snapshot now.",
          },
        ],
      },
      { throwOnError: true },
    );

    return await Effect.runPromise(
      Schema.decodeUnknown(ExplorerSnapshotSchema)(response.data.info.structured),
    );
  } finally {
    await client.session.delete({ sessionID }, { throwOnError: true }).catch(() => undefined);
  }
}

export function createExplorerReference(node: ExplorerNode): string {
  return (
    `Regarding the ${node.className} at \`${node.path}\`: ` +
    "treat this path only as a hint. Rediscover the object in the connected place and verify its identity and current state immediately before taking any action."
  );
}
