import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Schema } from "effect";
import type { GeneratedProgramArtifact, GeneratedProgramEnvelope } from "../types/generatedProgram";

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

export const EXPLORER_CONTRACT = {
  name: "explorer-snapshot",
  version: "1",
  inputSchemaVersion: "explorer-input-v1",
  outputSchemaVersion: "explorer-snapshot-v1",
} as const;

export const ExplorerProgramEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  contract: Schema.Struct({
    name: Schema.Literal(EXPLORER_CONTRACT.name),
    version: Schema.Literal(EXPLORER_CONTRACT.version),
    inputSchemaVersion: Schema.Literal(EXPLORER_CONTRACT.inputSchemaVersion),
    outputSchemaVersion: Schema.Literal(EXPLORER_CONTRACT.outputSchemaVersion),
  }),
  source: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100_000)),
});

export type ExplorerProgramEnvelope = typeof ExplorerProgramEnvelopeSchema.Type;

export interface ExplorerCollection {
  readonly program: GeneratedProgramEnvelope;
  readonly artifact: GeneratedProgramArtifact;
  readonly snapshot: ExplorerSnapshot;
}

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

export const EXPLORER_PROGRAM_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "contract", "source"],
  properties: {
    version: { const: 1 },
    contract: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version", "inputSchemaVersion", "outputSchemaVersion"],
      properties: {
        name: { const: EXPLORER_CONTRACT.name },
        version: { const: EXPLORER_CONTRACT.version },
        inputSchemaVersion: { const: EXPLORER_CONTRACT.inputSchemaVersion },
        outputSchemaVersion: { const: EXPLORER_CONTRACT.outputSchemaVersion },
      },
    },
    source: { type: "string", minLength: 1, maxLength: 100_000 },
  },
} as const;

export const EXPLORER_SNAPSHOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["placeName", "capturedAt", "roots"],
  properties: SNAPSHOT_PROPERTIES,
  $defs: { node: NODE_JSON_SCHEMA },
} as const;

const INITIAL_SYSTEM_PROMPT = `You generate the private TypeScript data provider for BloxBot's Explorer panel.
Discover the currently available Studio MCP tools and return an import-free deterministic read-only TypeScript program.
The source must define async function run({ input, callTool }) and return an Explorer snapshot matching the requested output contract. Use callTool directly with the exact discovered tool names and arguments. It must never modify the place.
Do not run a recurring model-mediated replay. The app will compile this source once and invoke it directly for every refresh.
For every object include a compact set of useful, readable properties and all available attributes. Stringify values safely.
Paths are dot-separated human-readable hints, not durable identifiers. Keep children in Studio order.
Return only the requested structured output.`;

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

export async function generateExplorerProgram(
  client: OpencodeClient,
  model?: ExplorerModel,
  agent?: string | null,
): Promise<ExplorerProgramEnvelope> {
  return withPrivateSession(client, async (sessionID) => {
    const response = await client.session.prompt(
      {
        sessionID,
        model,
        agent: agent ?? undefined,
        system: INITIAL_SYSTEM_PROMPT,
        format: { type: "json_schema", schema: EXPLORER_PROGRAM_OUTPUT_SCHEMA, retryCount: 2 },
        parts: [
          {
            type: "text",
            text: "Discover the read-only Studio tools and generate the reusable TypeScript Explorer program.",
          },
        ],
      },
      { throwOnError: true },
    );

    return Effect.runPromise(
      Schema.decodeUnknown(ExplorerProgramEnvelopeSchema)(response.data.info.structured),
    );
  });
}

export function createExplorerReference(node: ExplorerNode): string {
  return (
    `Regarding the ${node.className} at \`${node.path}\`: ` +
    "treat this path only as a hint. Rediscover the object in the connected place and verify its identity and current state immediately before taking any action."
  );
}
