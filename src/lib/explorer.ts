import { Schema } from "effect";

export const ExplorerFieldSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  /** A number or a list of them, so it can be shortened. Other text stays as written. */
  numeric: Schema.optional(Schema.Boolean),
  /** The Luau type of the value, like Vector3 or EnumItem. */
  type: Schema.optional(Schema.String),
  writable: Schema.optional(Schema.Boolean),
  /** Studio's grouping for a property, like Transform or Appearance. */
  category: Schema.optional(Schema.String),
  /** What the value can be, for enums and BrickColors. */
  options: Schema.optional(Schema.Array(Schema.String)),
  /** The color of each option, for BrickColors. */
  swatches: Schema.optional(Schema.Array(Schema.String)),
});

export type ExplorerField = typeof ExplorerFieldSchema.Type;

export const ExplorerNodeDetailsSchema = Schema.Struct({
  properties: Schema.Array(ExplorerFieldSchema),
  attributes: Schema.Array(ExplorerFieldSchema),
  /** Other objects share this path, so what's shown can't safely be changed. */
  locked: Schema.optional(Schema.Boolean),
  /** Read without a script to keep Studio's redo, so computed values are missing. */
  limited: Schema.optional(Schema.Literal("redo", "failed")),
  /** Only a script can read these, so they're missing when `limited`. */
  tags: Schema.optional(Schema.Array(Schema.String)),
  /** The tags used elsewhere in the place, to offer when adding one. */
  placeTags: Schema.optional(Schema.Array(Schema.String)),
});
export type ExplorerNodeDetails = typeof ExplorerNodeDetailsSchema.Type;

export const ExplorerNodeSchema = Schema.Struct({
  /** Tells apart objects that share a path. The path alone is what a message or a person sees. */
  id: Schema.optional(Schema.String),
  /** Which of the objects at this path it is, in Studio's order, and how many there are. */
  occurrence: Schema.optional(Schema.Number),
  occurrences: Schema.optional(Schema.Number),
  name: Schema.String,
  className: Schema.String,
  path: Schema.String,
  hasChildren: Schema.Boolean,
  /** Its children come in their own update, so anything already there stays until then. */
  pending: Schema.optional(Schema.Boolean),
  children: Schema.Array(Schema.suspend((): Schema.Schema<ExplorerNode> => ExplorerNodeSchema)),
  // The identifier lets the recursive schema be written out as JSON Schema
  // (for `pnpm bloxbot-programs brief`).
}).annotations({ identifier: "ExplorerNode" });

export interface ExplorerNode {
  readonly id?: string;
  readonly occurrence?: number;
  readonly occurrences?: number;
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly pending?: boolean;
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

export function nodeId(node: Pick<ExplorerNode, "id" | "path">): string {
  return node.id ?? node.path;
}

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

/** One changed part of the tree: the new children of an object, or the services for null. */
export const ExplorerTreeUpdateSchema = Schema.Struct({
  studioId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  children: Schema.Array(ExplorerNodeSchema),
  placeName: Schema.optional(Schema.String),
});

export type ExplorerTreeUpdate = typeof ExplorerTreeUpdateSchema.Type;

export const ExplorerSyncRequestSchema = Schema.Struct({
  fresh: Schema.Boolean,
  force: Schema.Boolean,
});

export type ExplorerSyncRequest = typeof ExplorerSyncRequestSchema.Type;

export const ExplorerSyncResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  /** Studio says when the tree changes, so there's no need to read it until it does. */
  watching: Schema.Boolean,
  complete: Schema.Boolean,
  truncated: Schema.Boolean,
  slowestReadMs: Schema.Number,
});

export type ExplorerSyncResult = typeof ExplorerSyncResultSchema.Type;

/** The tree as updates build it up. Objects are found by id, and changed in place. */
export interface ExplorerTree {
  readonly placeName: string;
  readonly roots: readonly ExplorerNode[];
  readonly byId: ReadonlyMap<string, ExplorerNode>;
}

export function emptyExplorerTree(): ExplorerTree {
  return { placeName: "", roots: [], byId: new Map() };
}

/**
 * Applies updates to a tree. Only the changed parts are touched, so this stays cheap in a big place.
 * An update for an object that has since gone is dropped.
 */
export function applyExplorerUpdates(
  tree: ExplorerTree,
  updates: readonly Pick<ExplorerTreeUpdate, "parentId" | "children" | "placeName">[],
): ExplorerTree {
  const byId = tree.byId as Map<string, ExplorerNode>;
  let { placeName, roots } = tree;
  const forget = (nodes: readonly ExplorerNode[]) => {
    for (const node of nodes) {
      byId.delete(nodeId(node));
      forget(node.children);
    }
  };
  const remember = (nodes: readonly ExplorerNode[]) => {
    for (const node of nodes) {
      byId.set(nodeId(node), node);
      remember(node.children);
    }
  };
  for (const update of updates) {
    placeName = update.placeName ?? placeName;
    const parent = update.parentId === null ? null : byId.get(update.parentId);
    if (parent === undefined) continue;
    const before = parent ? parent.children : roots;
    const held = new Map(before.map((node) => [nodeId(node), node]));
    const next = update.children.map((node) => {
      const old = node.pending ? held.get(nodeId(node)) : undefined;
      return old ? { ...node, children: old.children } : node;
    });
    forget(before);
    remember(next);
    if (parent) Object.assign(parent, { children: next, pending: false });
    else roots = next;
  }
  return { placeName, roots, byId };
}

export interface ExplorerRow {
  readonly node: ExplorerNode;
  readonly depth: number;
  readonly position: number;
  readonly siblings: number;
  /** Stands in for children that are still on their way. */
  readonly loading?: boolean;
}

/** The rows on screen for what's expanded, one list for however deep the tree goes. */
export function explorerRows(
  roots: readonly ExplorerNode[],
  expanded: ReadonlySet<string>,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  const add = (nodes: readonly ExplorerNode[], depth: number) => {
    nodes.forEach((node, index) => {
      rows.push({ node, depth, position: index + 1, siblings: nodes.length });
      if (!expanded.has(nodeId(node))) return;
      if (node.children.length > 0) add(node.children, depth + 1);
      else if (node.pending) {
        rows.push({ node, depth: depth + 1, position: 1, siblings: 1, loading: true });
      }
    });
  };
  add(roots, 0);
  return rows;
}

export function fieldNumbers(value: string): string[] {
  return value.split(/[\s,;{}()]+/).filter(Boolean);
}

/** Shortens numbers with more than 3 decimals, and very big or tiny ones to an exponent. */
export function shortenNumber(text: string): string {
  if (text === "-0") return "0";
  if (!/^-?\d+\.\d{4,}(?:e[-+]?\d+)?$/i.test(text)) return text;
  const number = Number(text);
  const size = Math.abs(number);
  // Rotations leave noise like 8.7e-15 behind where the value is really zero.
  if (size < 1e-9) return "0";
  if (size >= 1e15 || size < 0.001) return number.toExponential(2);
  return String(Number(number.toFixed(3)));
}

export function colorToBytes(value: string): number[] {
  return fieldNumbers(value)
    .slice(0, 3)
    .map((part) => Math.max(0, Math.min(255, Math.round(Number(part) * 255))));
}

export function colorToHex(value: string): string {
  const hex = colorToBytes(value).map((byte) => byte.toString(16).padStart(2, "0"));
  return `#${hex.join("")}`;
}

export interface HsvColor {
  readonly hue: number;
  readonly saturation: number;
  readonly value: number;
}

export function hsvToHex({ hue, saturation, value }: HsvColor): string {
  const channel = (offset: number) => {
    const k = (offset + hue / 60) % 6;
    const byte = Math.round(
      255 * (value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1))),
    );
    return byte.toString(16).padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

export function hexToHsv(hex: string): HsvColor {
  const [r, g, b] = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta + 6) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return { hue: hue * 60, saturation: max === 0 ? 0 : delta / max, value: max };
}

export function colorFromHex(hex: string): string {
  return [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .join(", ");
}

/** The same short numbers everywhere a value is shown or copied. */
export function readableFieldValue({ value, numeric }: ExplorerField): string {
  return numeric ? value.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi, shortenNumber) : value;
}

/**
 * A value as people want to read it: `Enum.CameraType.Fixed` as "Fixed", a CFrame by its position,
 * a Color3 in 0 to 255, and numbers with more than 3 decimals, alone or in lists, shortened.
 */
/**
 * Puts back every digit of the numbers an edit left alone, so changing one number in a long value
 * can't round the others. A different count of numbers can't be matched up, so that stays as typed.
 */
export function keepExactNumbers(edited: string, field: ExplorerField): string {
  const exact = fieldNumbers(field.value);
  const shown = fieldNumbers(readableFieldValue(field));
  const parts = edited.split(/([\s,;{}()]+)/);
  if (exact.length !== shown.length || fieldNumbers(edited).length !== exact.length) return edited;
  let index = 0;
  return parts
    .map((part) => {
      if (!part || /^[\s,;{}()]+$/.test(part)) return part;
      const position = index++;
      return part === shown[position] ? exact[position] : part;
    })
    .join("");
}

export function formatFieldValue(field: ExplorerField): string {
  const { value, type } = field;
  if (value === "" && (type === "Instance" || type === "PhysicalProperties")) {
    return type === "Instance" ? "None" : "Default";
  }
  if (type === "Color3") return colorToBytes(value).join(", ");
  if (type === "CFrame") return fieldNumbers(value).slice(0, 3).map(shortenNumber).join(", ");
  if (!type || type === "EnumItem") {
    const enumItem = /^Enum\.\w+\.(\w+)$/.exec(value);
    if (enumItem) return enumItem[1];
  }
  return readableFieldValue(field);
}

interface FieldSection {
  readonly title?: string;
  readonly labels: readonly string[];
  readonly columns?: number;
}

/** The numbers that make up each value, in the order Studio writes them. */
export const FIELD_SHAPES: Readonly<Record<string, readonly FieldSection[]>> = {
  Vector3: [{ labels: ["X", "Y", "Z"] }],
  Vector3int16: [{ labels: ["X", "Y", "Z"] }],
  Vector2: [{ labels: ["X", "Y"] }],
  Vector2int16: [{ labels: ["X", "Y"] }],
  CFrame: [
    { title: "Position", labels: ["X", "Y", "Z"] },
    { title: "Orientation", labels: ["RX", "RY", "RZ"] },
  ],
  UDim: [{ labels: ["Scale", "Offset"] }],
  UDim2: [
    { title: "X", labels: ["X Scale", "X Offset"] },
    { title: "Y", labels: ["Y Scale", "Y Offset"] },
  ],
  Rect: [{ labels: ["Min X", "Min Y", "Max X", "Max Y"], columns: 2 }],
  NumberRange: [{ labels: ["Min", "Max"] }],
  PhysicalProperties: [
    {
      labels: [
        "Density",
        "Friction",
        "Elasticity",
        "Friction weight",
        "Elasticity weight",
        "Acoustic absorption",
      ],
      columns: 3,
    },
  ],
};

export function fieldEditor(type: string | undefined) {
  if (type === "boolean" || type === "EnumItem") return "choice";
  if (type === "BrickColor") return "palette";
  if (type === "Faces" || type === "Axes" || type === "SecurityCapabilities") return "flags";
  if (type === "Instance") return "object";
  if (type === "Font") return "font";
  if (type === "Color3") return "color";
  return type && FIELD_SHAPES[type] ? "tuple" : "text";
}

// These never change, so unlike enums they don't need to come from Studio with every read.
const FIXED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  boolean: ["true", "false"],
  Faces: ["Right", "Top", "Back", "Left", "Bottom", "Front"],
  Axes: ["X", "Y", "Z"],
};
export const FONT_WEIGHTS = [
  "Thin",
  "ExtraLight",
  "Light",
  "Regular",
  "Medium",
  "SemiBold",
  "Bold",
  "ExtraBold",
  "Heavy",
];
export const FONT_STYLES = ["Normal", "Italic"];

export function fieldOptions(field: ExplorerField): readonly string[] {
  return field.options ?? FIXED_OPTIONS[field.type ?? ""] ?? [];
}

/**
 * The objects a property can point at. A path has to name one object, so this leaves out objects
 * sharing a path and anything inside them.
 */
export function objectPaths(roots: readonly ExplorerNode[]): string[] {
  const paths: string[] = [];
  const visit = (nodes: readonly ExplorerNode[]) => {
    for (const node of nodes) {
      if ((node.occurrences ?? 1) > 1) continue;
      paths.push(node.path);
      visit(node.children);
    }
  };
  visit(roots);
  return paths;
}

export function canEditValue(field: ExplorerField): boolean {
  return field.writable === true;
}

// Studio's order for the categories people use most. The rest follow alphabetically.
const CATEGORY_ORDER = [
  "Appearance",
  "Data",
  "Transform",
  "Pivot",
  "Behavior",
  "Collision",
  "Part",
  "Assembly",
];

export function groupFields(fields: readonly ExplorerField[]) {
  const groups = new Map<string, ExplorerField[]>();
  for (const field of fields) {
    const category = field.category ?? "Other";
    groups.set(category, [...(groups.get(category) ?? []), field]);
  }
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category);
    return index === -1 ? CATEGORY_ORDER.length : index;
  };
  return [...groups]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, grouped]) => ({ category, fields: grouped }));
}

export const ATTRIBUTE_TYPES = [
  "string",
  "boolean",
  "number",
  "Vector3",
  "Vector2",
  "Color3",
  "BrickColor",
  "CFrame",
  "UDim",
  "UDim2",
  "NumberRange",
  "Rect",
  "NumberSequence",
  "ColorSequence",
] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

/** Roblox's rule for attribute names. */
export function isAttributeName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,100}$/.test(name) && !/^RBX/i.test(name);
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

export type ExplorerFieldKind = "property" | "attribute";
export type ExplorerReferenceKind = ExplorerFieldKind | "tag";

/** An object, or one of its fields, to mention in a message. */
export interface ExplorerReference {
  readonly name: string;
  readonly path: string;
  readonly field?: { readonly kind: ExplorerReferenceKind; readonly name: string };
}

/** What an object dragged out of Explorer carries: its path, which the message box looks up. */
export const OBJECT_DRAG_TYPE = "application/x-bloxbot-object";

// Roblox's limit on Instance.Name.
const ObjectNameSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100));
const FieldNameSchema = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256));
const EditedObjectFields = {
  occurrence: Schema.optional(Schema.Number),
  occurrences: Schema.optional(Schema.Number),
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536)),
  className: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
};

export const ExplorerEditSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("rename"),
    name: ObjectNameSchema,
    ...EditedObjectFields,
  }),
  Schema.Struct({ action: Schema.Literal("duplicate", "delete"), ...EditedObjectFields }),
  Schema.Struct({
    action: Schema.Literal("setField"),
    kind: Schema.Literal("property", "attribute"),
    field: FieldNameSchema,
    value: Schema.String.pipe(Schema.maxLength(200_000)),
    valueType: Schema.String.pipe(Schema.maxLength(64)),
    ...EditedObjectFields,
  }),
  Schema.Struct({
    action: Schema.Literal("addAttribute"),
    field: FieldNameSchema,
    valueType: Schema.Literal(...ATTRIBUTE_TYPES),
    ...EditedObjectFields,
  }),
  Schema.Struct({
    action: Schema.Literal("removeAttribute", "addTag", "removeTag"),
    field: FieldNameSchema,
    ...EditedObjectFields,
  }),
);
export type ExplorerEdit = typeof ExplorerEditSchema.Type;

export const ExplorerEditResultSchema = Schema.Struct({ name: Schema.String });
export type ExplorerEditResult = typeof ExplorerEditResultSchema.Type;

// Roblox doesn't let these be renamed, moved or removed, or breaks without them.
const FIXED_CLASSES = new Set(["Terrain", "StarterPlayerScripts", "StarterCharacterScripts"]);

/** Services sit directly under the place, so their paths are just `game.Name`. */
export function canEditObject({ name, path, className }: ExplorerNode): boolean {
  return path !== `game.${name}` && !FIXED_CLASSES.has(className);
}

/** The path of an object's sibling, which holds even when a name has a period in it. */
export function siblingPath({ name, path }: ExplorerNode, siblingName: string): string {
  return `${path.slice(0, -name.length)}${siblingName}`;
}

/** The id an object has after a rename: its parent's, then its new name. */
export function renamedId(node: ExplorerNode, name: string): string {
  const id = nodeId(node);
  return `${id.slice(0, id.lastIndexOf(`.${node.name}`) + 1)}${name}`;
}

export const ExplorerDetailsRequestSchema = Schema.Struct({
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(65_536)),
  className: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  occurrence: Schema.optional(Schema.Number),
  occurrences: Schema.optional(Schema.Number),
  /** Reading again on its own, so it won't run a script if that could clear Studio's redo. */
  background: Schema.optional(Schema.Boolean),
});
export type ExplorerDetailsRequest = typeof ExplorerDetailsRequestSchema.Type;
