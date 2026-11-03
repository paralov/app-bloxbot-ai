import { Schema } from "effect";

export const ExplorerFieldSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
});

export type ExplorerField = typeof ExplorerFieldSchema.Type;

export const ExplorerNodeDetailsSchema = Schema.Struct({
  properties: Schema.Array(ExplorerFieldSchema),
  attributes: Schema.Array(ExplorerFieldSchema),
});
export type ExplorerNodeDetails = typeof ExplorerNodeDetailsSchema.Type;

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
  truncated: Schema.optional(Schema.Boolean),
  placeName: Schema.String,
  capturedAt: Schema.String,
  roots: Schema.Array(ExplorerNodeSchema),
});

export type ExplorerSnapshot = typeof ExplorerSnapshotSchema.Type;

/**
 * A property value as people want to read it: `Enum.CameraType.Fixed` as "Fixed", and numbers,
 * alone or in lists like a Vector3, at 3 decimals. Anything else is left as Studio wrote it.
 */
export function formatFieldValue(value: string): string {
  const enumItem = /^Enum\.\w+\.(\w+)$/.exec(value);
  if (enumItem) return enumItem[1];
  if (!/\d/.test(value) || !/^[-+\d.,;\se]+$/i.test(value)) return value;
  return value.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, (text) => {
    const number = Number(text);
    if (Number.isInteger(number) && Math.abs(number) < 1e15) return String(number);
    return Math.abs(number) < 1e15 ? String(Number(number.toFixed(3))) : number.toExponential(2);
  });
}

/**
 * Finds objects by how a reply might name them: the full path, with or without "game.", or a name
 * only one object has. A name several objects share stays out, so it can't open the wrong one.
 */
export function indexExplorerObjects(roots: readonly ExplorerNode[]) {
  const byName = new Map<string, ExplorerNode | null>();
  const byPath = new Map<string, ExplorerNode>();
  const visit = (node: ExplorerNode) => {
    byName.set(node.name, byName.has(node.name) ? null : node);
    byPath.set(node.path, node);
    byPath.set(node.path.replace(/^game\./, ""), node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return new Map([...byName, ...byPath]);
}

export function createExplorerReference(node: ExplorerNode): string {
  return (
    `Regarding the ${node.className} at \`${node.path}\`: ` +
    "treat this path only as a hint. Rediscover the object in the connected place and verify its identity and current state immediately before taking any action."
  );
}
