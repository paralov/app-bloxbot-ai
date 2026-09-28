import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Effect, Schema } from "effect";
import type { GeneratedProgramArtifact, GeneratedProgramEnvelope } from "../types/generatedProgram";
import { STUDIO_MCP_SERVER_NAME } from "./bloxbotProgramManifest";

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
  // The identifier lets the recursive schema be written out as JSON Schema
  // (for `pnpm bloxbot-programs brief`).
}).annotations({ identifier: "ExplorerNode" });

export interface ExplorerNode {
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly properties: readonly ExplorerField[];
  readonly attributes: readonly ExplorerField[];
  readonly children: readonly ExplorerNode[];
}

// Roblox Studio sorts Explorer rows by ReflectionMetadataClass.ExplorerOrder,
// then class, then Instance.Name. Unknown classes use Model's neutral band.
const EXPLORER_ORDER: Readonly<Record<string, number>> = {
  Workspace: 5,
  Camera: 5,
  Terrain: 5,
  Actor: 10,
  Folder: 10,
  Players: 20,
  Attachment: 30,
  Humanoid: 30,
  Lighting: 30,
  MaterialService: 30,
  NetworkClient: 30,
  ReplicatedFirst: 30,
  ReplicatedStorage: 30,
  Script: 30,
  ServerScriptService: 30,
  ServerStorage: 30,
  SpawnLocation: 30,
  StarterGui: 30,
  StarterPack: 30,
  StarterPlayer: 30,
  Tool: 30,
  LocalScript: 40,
  RemoteFunction: 40,
  BindableFunction: 40,
  Decal: 40,
  Texture: 40,
  ModuleScript: 50,
  RemoteEvent: 50,
  BindableEvent: 50,
  Model: 100,
  MeshPart: 105,
  UnionOperation: 105,
  Part: 110,
  TrussPart: 120,
  WedgePart: 120,
  Teams: 140,
  ScreenGui: 140,
  BillboardGui: 140,
  SurfaceGui: 140,
  Frame: 150,
  ImageButton: 160,
  TextButton: 170,
  ImageLabel: 180,
  TextLabel: 190,
  Configuration: 220,
  SoundService: 500,
  TextChatService: 511,
};

const explorerCollator = new Intl.Collator(undefined, { sensitivity: "base" });

export function sortExplorerNodes(nodes: readonly ExplorerNode[]): readonly ExplorerNode[] {
  return nodes
    .map((node) => ({ ...node, children: sortExplorerNodes(node.children) }))
    .sort((left, right) => {
      const order =
        (EXPLORER_ORDER[left.className] ?? 100) - (EXPLORER_ORDER[right.className] ?? 100);
      if (order !== 0) return order;
      const classOrder = explorerCollator.compare(left.className, right.className);
      return classOrder !== 0 ? classOrder : explorerCollator.compare(left.name, right.name);
    });
}

export function sortExplorerSnapshot(snapshot: ExplorerSnapshot): ExplorerSnapshot {
  return { ...snapshot, roots: sortExplorerNodes(snapshot.roots) };
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
  /** Where the program came from, which decides how a later failure recovers. */
  readonly origin: "published" | "builtin" | "model";
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

/**
 * The system prompt for writing an Explorer program. It names the tools the
 * runtime lets the program call, by Studio's own name: in its own session the
 * model sees them with OpenCode's server prefix (roblox-studio_search_game_tree).
 */
export function explorerSystemPrompt(allowedTools: readonly string[]): string {
  return `You generate the private TypeScript data provider for BloxBot's Explorer panel.
Discover the currently available Studio MCP tools and return an import-free deterministic read-only TypeScript program.
The source must define async function run({ input, callTool }), require input.studioId, and return an Explorer snapshot matching the requested output contract. It must never modify the place.
The program may only call these tools, by exactly these names: ${allowedTools.join(", ")}. The runtime refuses any other tool. Use these names in callTool even though your own tool list shows them with a "${STUDIO_MCP_SERVER_NAME}_" prefix. Pass { studio_id: input.studioId } on every Studio-specific tool call.
callTool resolves to a raw MCP CallToolResult ({ content, isError }). When isError is true, content holds Studio's error text; it does not throw. Tool output is usually JSON inside a text content part, sometimes after a note, so parse it defensively.
The words import and export must not appear anywhere in the source, not even in comments or strings. Use only standard JavaScript globals; there is no network or file access.
The value run returns must be JSON-safe and match this JSON Schema exactly, with no extra properties:
${JSON.stringify(EXPLORER_SNAPSHOT_OUTPUT_SCHEMA)}
Do not run a recurring model-mediated replay. The app will compile this source once and invoke it directly for every refresh.
For every object include a compact set of useful, readable properties and all available attributes. Stringify values safely.
Use each instance's Name property for node.name. Use ClassName only for node.className and type/icon metadata.
Request the deepest complete hierarchy and a very high result limit supported by the discovered tree tool; do not accept shallow defaults.
Paths are dot-separated human-readable hints, not durable identifiers. Keep children in Studio order.
Return only the requested structured output.`;
}

/** At most this many programs are written per attempt, the first plus one retry. */
export const MAX_EXPLORER_GENERATIONS = 2;

/** A failed model-written program, with how many programs the model wrote. */
export class ExplorerGenerationError extends Error {
  constructor(
    readonly cause: unknown,
    readonly attempts: number,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "ExplorerGenerationError";
  }
}

interface ExplorerModel {
  providerID: string;
  modelID: string;
}

export interface GenerateExplorerProgramOptions<T> {
  model?: ExplorerModel;
  agent?: string | null;
  /** The tools the runtime lets the program call, by Studio's own name. */
  allowedTools: readonly string[];
  /**
   * Compiles the program and runs it once. A failure goes back to the model,
   * which writes one more program.
   */
  validate: (program: ExplorerProgramEnvelope) => Promise<T>;
}

export interface GeneratedExplorerProgram<T> {
  program: ExplorerProgramEnvelope;
  result: T;
  /** How many programs the model wrote. */
  attempts: number;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Has the model write an Explorer program in a private session and checks it
 * with validate before accepting it. When the check fails, the error goes back
 * to the model in the same session for one corrected program.
 */
export async function generateExplorerProgram<T>(
  client: OpencodeClient,
  { model, agent, allowedTools, validate }: GenerateExplorerProgramOptions<T>,
): Promise<GeneratedExplorerProgram<T>> {
  let attempts = 0;
  try {
    return await withPrivateSession(client, async (sessionID) => {
      let request =
        "Discover the read-only Studio tools and generate the reusable TypeScript Explorer program.";
      for (;;) {
        const response = await client.session.prompt(
          {
            sessionID,
            model,
            agent: agent ?? undefined,
            system: explorerSystemPrompt(allowedTools),
            format: { type: "json_schema", schema: EXPLORER_PROGRAM_OUTPUT_SCHEMA, retryCount: 2 },
            parts: [{ type: "text", text: request }],
          },
          { throwOnError: true },
        );
        // Counts programs the model returned, not prompts that failed.
        attempts += 1;
        try {
          const program = await Effect.runPromise(
            Schema.decodeUnknown(ExplorerProgramEnvelopeSchema)(response.data.info.structured),
          );
          return { program, result: await validate(program), attempts };
        } catch (error) {
          if (attempts >= MAX_EXPLORER_GENERATIONS) throw error;
          request = `BloxBot compiled and ran your program once, and it failed: ${errorMessage(error)}
Fix the cause and return the complete corrected program. Call only these tools, by exactly these names: ${allowedTools.join(", ")}.`;
        }
      }
    });
  } catch (error) {
    throw new ExplorerGenerationError(error, attempts);
  }
}

export function createExplorerReference(node: ExplorerNode): string {
  return (
    `Regarding the ${node.className} at \`${node.path}\`: ` +
    "treat this path only as a hint. Rediscover the object in the connected place and verify its identity and current state immediately before taking any action."
  );
}
