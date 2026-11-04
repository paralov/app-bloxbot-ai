import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type {
  AttributeType,
  ExplorerDetailsRequest,
  ExplorerEdit,
  ExplorerEditResult,
  ExplorerNodeDetails,
} from "../src/lib/explorer";
import type { StudioTarget, StudioTargetDiscovery, StudioTargetSelection } from "../src/types/studioTarget";

export type CallStudioTool = (
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<CallToolResult>;

// Studio MCP can put a note such as "Note: Output limited to N nodes" before
// the JSON, so fall back to parsing from the first bracket.
function parseMcpText(text: string): any {
  try {
    return JSON.parse(text);
  } catch {}
  const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index > 0);
  if (starts.length > 0) {
    try {
      return JSON.parse(text.slice(Math.min(...starts)));
    } catch {}
  }
  return text;
}

export function mcpData(result: CallToolResult): any {
  for (const part of result.content ?? []) {
    if ((part as any).type === "json") return (part as any).json;
    if (part.type === "text") return parseMcpText(part.text);
  }
  return null;
}

export function mcpError(result: CallToolResult): string | null {
  if (result.isError !== true) return null;
  const text = (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim();
  return text || "Studio returned an error";
}

function identifier(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function toTarget(studio: any): StudioTarget | null {
  const key = identifier(studio?.studio_id ?? studio?.studioId ?? studio?.id);
  if (!key) return null;
  // Studio can report 0 for a place that was never published, which says nothing about which one.
  const reportedPlaceId = identifier(studio?.place_id ?? studio?.placeId);
  const placeId = reportedPlaceId === "0" ? null : reportedPlaceId;
  const label = studio?.name ?? studio?.place_name ?? studio?.placeName;
  return {
    key,
    label: typeof label === "string" && label ? label : key,
    detail: placeId ? `Place ${placeId}` : "Local place",
    placeId,
  };
}

async function listStudios(callTool: CallStudioTool): Promise<StudioTarget[]> {
  const result = await callTool("list_roblox_studios", {});
  const error = mcpError(result);
  if (error) throw new Error(error);
  const data = mcpData(result) ?? {};
  const studios: unknown[] = Array.isArray(data) ? data : Array.isArray(data.studios) ? data.studios : [];
  return studios.flatMap((studio) => toTarget(studio) ?? []);
}

export async function discoverStudioTargets(
  callTool: CallStudioTool,
): Promise<StudioTargetDiscovery> {
  return { targets: await listStudios(callTool), selectedKey: null };
}

/** The account signed in to this Studio, which is what decides which uploads it can load. */
export async function readStudioAccount(callTool: CallStudioTool, studioId: string): Promise<string> {
  const result = await callTool("execute_luau", {
    studio_id: studioId,
    datamodel_type: "Edit",
    code: `return tostring(game:GetService("StudioService"):GetUserId())`,
  });
  const error = mcpError(result);
  if (error) throw new Error(error);
  const id = String(mcpData(result) ?? "").trim();
  if (!/^[1-9]\d*$/.test(id)) throw new Error("Studio isn't signed in");
  return id;
}

/** Puts an uploaded model in the place, and returns where it went. */
export async function insertUploadedModel(
  callTool: CallStudioTool,
  studioId: string,
  assetId: string,
  name: string,
): Promise<string> {
  const assetName = name.replace(/[^\p{L}\p{N}_]+/gu, "");
  const result = await callTool("insert_asset", {
    studio_id: studioId,
    assetId,
    assetName: assetName || "Model",
    assetType: "Model",
  });
  const error = mcpError(result);
  if (error) throw new Error(error);
  const inserted = mcpData(result)?.insertedInstances?.[0]?.fullPath;
  if (typeof inserted !== "string") throw new Error("Studio returned an unreadable answer");
  // insert_asset marks anything from Open Cloud as a package, which this isn't. Only the newest match
  // is the new model, since the place may have its own package with this name.
  await callTool("execute_luau", {
    studio_id: studioId,
    datamodel_type: "Edit",
    code: `local children = workspace:GetChildren()
for index = #children, 1, -1 do
  if children[index].Name == ${JSON.stringify(assetName || "Model")} then
    local link = children[index]:FindFirstChildOfClass("PackageLink")
    if link then link:Destroy() end
    break
  end
end`,
  }).catch(() => {});
  return inserted;
}

export async function selectStudioTarget(
  callTool: CallStudioTool,
  targetKey: string,
): Promise<StudioTargetSelection> {
  const selected = (await listStudios(callTool)).find((target) => target.key === targetKey);
  if (!selected) throw new Error("Studio target could not be verified");
  return { selected, verified: true };
}

// Match Studio Explorer's default service set. Studio hides less commonly
// edited engine services unless the user explicitly enables them.
export const VISIBLE_SERVICES = new Set([
  "Workspace",
  "Players",
  "Lighting",
  "MaterialService",
  "ReplicatedFirst",
  "ReplicatedStorage",
  "ServerScriptService",
  "ServerStorage",
  "StarterGui",
  "StarterPack",
  "StarterPlayer",
  "Teams",
  "SoundService",
  "TextChatService",
]);

const NUMERIC_TYPES = new Set([
  "number",
  "Vector3",
  "Vector3int16",
  "Vector2",
  "Vector2int16",
  "Color3",
  "CFrame",
  "UDim",
  "UDim2",
  "Rect",
  "NumberRange",
  "PhysicalProperties",
  "NumberSequence",
  "ColorSequence",
]);

function toFields(values: unknown) {
  if (!Array.isArray(values)) throw new Error("Studio returned unreadable object details");
  return values
    .filter((field) => typeof field?.name === "string" && typeof field?.value === "string")
    .map((field) => ({
      name: field.name as string,
      value: field.value as string,
      type: typeof field.type === "string" ? field.type : undefined,
      writable: field.writable === true,
      ...(typeof field.category === "string" ? { category: field.category } : {}),
      ...(Array.isArray(field.options) ? { options: field.options as string[] } : {}),
      ...(NUMERIC_TYPES.has(field.type) ? { numeric: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Object names come from the place, so they go in JSON-encoded. A name can contain a period, so
// this follows whole names instead of splitting the path. Studio's paths can't tell A.B from B
// inside A, and scripts can't read an object's UniqueId, so edits refuse to guess between them.
function findMatchesLuau(path: string) {
  return `local matches = {}
local function find(parent, rest)
  for _, child in parent:GetChildren() do
    if child.Name == rest then table.insert(matches, child) end
    if string.sub(rest, 1, #child.Name + 1) == child.Name .. "." then
      find(child, string.sub(rest, #child.Name + 2))
    end
  end
end
find(game, ${JSON.stringify(path.replace(/^game\./, ""))})`;
}

/** The object one row stands for. If the place no longer matches the tree, nothing gets touched. */
function findObjectLuau(target: {
  path: string;
  className: string;
  occurrence?: number;
  occurrences?: number;
}) {
  return `${findMatchesLuau(target.path)}
if #matches ~= ${target.occurrences ?? 1} then error("Found " .. #matches .. " objects at this path") end
local instance = matches[${(target.occurrence ?? 0) + 1}]
if instance.ClassName ~= ${JSON.stringify(target.className)} then error("Found 0 objects at this path") end`;
}

// How each type becomes text, which VALUE_FROM_TEXT_LUAU reads back. A type without an entry shows
// as Studio prints it and can't be edited here. A CFrame is its position and orientation in degrees.
export const VALUE_TO_TEXT_LUAU = `local function asIs(value) return tostring(value) end
local TO_TEXT = {
  boolean = asIs, number = asIs, string = asIs, EnumItem = asIs, BrickColor = asIs,
  Vector3 = asIs, Vector3int16 = asIs, Vector2 = asIs, Vector2int16 = asIs,
  UDim = asIs, UDim2 = asIs, NumberRange = asIs, NumberSequence = asIs, ColorSequence = asIs,
  Faces = asIs, Axes = asIs,
  Rect = function(v) return v.Min.X .. ", " .. v.Min.Y .. ", " .. v.Max.X .. ", " .. v.Max.Y end,
  Color3 = function(v) return v.R .. ", " .. v.G .. ", " .. v.B end,
  CFrame = function(v)
    local x, y, z = v:ToOrientation()
    return v.X .. ", " .. v.Y .. ", " .. v.Z .. ", " .. math.deg(x) .. ", " .. math.deg(y) .. ", " .. math.deg(z)
  end,
  PhysicalProperties = function(v)
    return v.Density .. ", " .. v.Friction .. ", " .. v.Elasticity .. ", " .. v.FrictionWeight .. ", " .. v.ElasticityWeight .. ", " .. v.AcousticAbsorption
  end,
  Font = function(v) return v.Family .. ", " .. v.Weight.Name .. ", " .. v.Style.Name end,
  Instance = function(v)
    if v == game then return "game" end
    return "game." .. v:GetFullName()
  end,
  Content = function(v) return v.Uri or "" end,
  SecurityCapabilities = function(v)
    local names = {}
    for _, item in Enum.SecurityCapability:GetEnumItems() do
      if v:Contains(item) then table.insert(names, item.Name) end
    end
    return table.concat(names, ", ")
  end,
}`;

// Everything Studio's own properties panel has, with real types. It only reads, but Studio still
// records it, which clears redo, so it only runs when there's nothing to redo.
function readDetailsLuau(request: ExplorerDetailsRequest) {
  return `${findObjectLuau(request)}
${VALUE_TO_TEXT_LUAU}
local MAX_TEXT = 2000
local function describe(name, value, declaredType, canWrite, category)
  local kind = if value ~= nil then typeof(value) else declaredType
  local toText = TO_TEXT[kind]
  local field = { name = name, type = kind, category = category, writable = canWrite and toText ~= nil }
  if value == nil then
    field.value = ""
  elseif toText then
    field.value = toText(value)
  else
    field.value = tostring(value)
  end
  if #field.value > MAX_TEXT then
    field.value = string.sub(field.value, 1, MAX_TEXT)
    field.writable = false
  end
  if kind == "EnumItem" and value ~= nil then
    field.options = {}
    for _, item in value.EnumType:GetEnumItems() do table.insert(field.options, item.Name) end
  elseif kind == "SecurityCapabilities" then
    field.options = {}
    for _, item in Enum.SecurityCapability:GetEnumItems() do table.insert(field.options, item.Name) end
  end
  return field
end
local properties = {}
for _, property in game:GetService("ReflectionService"):GetPropertiesOfClass(instance.ClassName) do
  local display = property.Display
  -- Properties without a display are engine internals, and deprecated ones are old aliases.
  if display and not display.DeprecationMessage and string.match(property.Name, "^%u") then
    local ok, value = pcall(function() return instance[property.Name] end)
    local declared = property.Type.ScriptType
    if ok and (value ~= nil or declared == "Instance" or declared == "PhysicalProperties") then
      table.insert(properties, describe(property.Name, value, declared, property.Permits.Write ~= nil, display.Category))
    end
  end
end
-- Where a Model moves from. It isn't a property, but it's the only way to move one.
if instance:IsA("PVInstance") then
  table.insert(properties, describe("Pivot", instance:GetPivot(), "CFrame", true, "Pivot"))
end
local attributes = {}
for name, value in instance:GetAttributes() do
  table.insert(attributes, describe(name, value, nil, true, nil))
end
local CollectionService = game:GetService("CollectionService")
local placeTags = {}
-- Studio's own interface tags objects in CoreGui, and those don't belong to the place.
local CoreGui = game:GetService("CoreGui")
for _, tag in CollectionService:GetAllTags() do
  for _, tagged in CollectionService:GetTagged(tag) do
    if not tagged:IsDescendantOf(CoreGui) then
      table.insert(placeTags, tag)
      break
    end
  end
end
return game:GetService("HttpService"):JSONEncode({ properties = properties, attributes = attributes, tags = instance:GetTags(), placeTags = placeTags })`;
}

// Everything Studio knows about classes and enums, read a page at a time because a call's output
// stops at about 100KB. This is the one script reads rely on, and it runs once per launch.
const REFLECTION_PAGE_BYTES = 80_000;

function reflectionPageLuau(start: number) {
  return `local HttpService = game:GetService("HttpService")
local ReflectionService = game:GetService("ReflectionService")
local entries = {}
for _, class in ReflectionService:GetClasses() do table.insert(entries, class) end
table.sort(entries, function(a, b) return a.Name < b.Name end)
local classCount = #entries
local enums = Enum:GetEnums()
local page = { classes = {}, enums = {}, brickColors = {} }
local used = 0
local index = ${start}
local total = classCount + #enums + 1
while index <= total and used < ${REFLECTION_PAGE_BYTES} do
  if index <= classCount then
    local class = entries[index]
    local own = {}
    for _, property in ReflectionService:GetPropertiesOfClass(class.Name) do
      local display = property.Display
      if property.Owner == class.Name and display and not display.DeprecationMessage and string.match(property.Name, "^%u") then
        table.insert(own, { property.Name, property.Type.ScriptType, property.Type.EnumType or false, property.Permits.Write ~= nil, display.Category })
      end
    end
    local entry = { class.Superclass or false, own }
    page.classes[class.Name] = entry
    used += #class.Name + #HttpService:JSONEncode(entry)
  elseif index <= classCount + #enums then
    local enum = enums[index - classCount]
    local names = {}
    for _, item in enum:GetEnumItems() do table.insert(names, item.Name) end
    page.enums[tostring(enum)] = names
    used += #tostring(enum) + #HttpService:JSONEncode(names)
  else
    local seen = {}
    for number = 0, 127 do
      local color = BrickColor.palette(number)
      if not seen[color.Name] then
        seen[color.Name] = true
        table.insert(page.brickColors, { color.Name, "#" .. color.Color:ToHex() })
      end
    end
  end
  index += 1
end
page.next = if index <= total then index else false
return HttpService:JSONEncode(page)`;
}

interface Reflection {
  classes: Record<string, [string | false, [string, string, string | false, boolean, string][]]>;
  enums: Record<string, string[]>;
  brickColors: [string, string][];
}

const NO_REFLECTION: Reflection = { classes: {}, enums: {}, brickColors: [] };
let reflection: Promise<Reflection> | null = null;
// Reading class data takes a script, so a read that must not run one can only use what's here.
let loadedReflection: Reflection | null = null;

async function readReflection(callTool: CallStudioTool, studioId: string): Promise<Reflection> {
  const result: Reflection = { classes: {}, enums: {}, brickColors: [] };
  let start: number | false = 1;
  while (start !== false) {
    // Each page is a script, and the user can undo something in Studio between them.
    if (start !== 1 && (await readHistoryState(callTool, studioId)).redo === "can-redo") {
      throw new Error("Studio has something to redo");
    }
    let page: any = null;
    let lastError = "";
    // Like every script, this can't use "Edit" during a playtest.
    for (const datamodelType of ["Edit", "Server", "Client"]) {
      const response = await callTool("execute_luau", {
        studio_id: studioId,
        datamodel_type: datamodelType,
        code: reflectionPageLuau(start),
      });
      const error = mcpError(response);
      if (!error) {
        page = mcpData(response);
        break;
      }
      lastError = error;
    }
    if (!page?.classes) throw new Error(lastError || "Studio returned unreadable class data");
    Object.assign(result.classes, page.classes);
    Object.assign(result.enums, page.enums);
    result.brickColors.push(...(page.brickColors ?? []));
    start = typeof page.next === "number" ? page.next : false;
  }
  return result;
}

function reflectionFor(callTool: CallStudioTool, studioId: string) {
  reflection ??= readReflection(callTool, studioId).then(
    (data) => {
      loadedReflection = data;
      return data;
    },
    (error) => {
      reflection = null;
      throw error;
    },
  );
  return reflection;
}

/** Forgets what's been read from Studio, for tests. */
export function resetStudioCaches() {
  reflection = null;
  loadedReflection = null;
}

function classChain(data: Reflection, className: string): string[] {
  const chain: string[] = [];
  let current: string | false | undefined = className;
  while (current && data.classes[current] && !chain.includes(current)) {
    chain.push(current);
    current = data.classes[current][0];
  }
  return chain;
}

const numbersOf = (text: unknown) =>
  typeof text === "string" ? text.split(/[\s,]+/).filter(Boolean).map(Number) : [];

// The same order as CFrame:ToOrientation().
function orientationOf(rotation: readonly number[]) {
  const [r00, , r02, r10, r11, r12, r20, , r22] = rotation;
  const degrees = (radians: number) => (radians * 180) / Math.PI;
  const x = Math.asin(Math.max(-1, Math.min(1, -r12)));
  if (Math.abs(r12) < 0.999999) {
    return [degrees(x), degrees(Math.atan2(r02, r22)), degrees(Math.atan2(r10, r11))];
  }
  return [degrees(x), degrees(Math.atan2(-r20, r00)), 0];
}

/** A CFrame's position and rotation combined, like a part's pivot from its offset. */
function multiplyFrames(a: { p: number[]; r: number[] }, b: { p: number[]; r: number[] }) {
  const r: number[] = [];
  const p: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      r.push(
        a.r[row * 3] * b.r[column] + a.r[row * 3 + 1] * b.r[3 + column] + a.r[row * 3 + 2] * b.r[6 + column],
      );
    }
    p.push(
      a.r[row * 3] * b.p[0] + a.r[row * 3 + 1] * b.p[1] + a.r[row * 3 + 2] * b.p[2] + a.p[row],
    );
  }
  return { p, r };
}

function frameOf(values: Record<string, unknown>, name: string) {
  const p = numbersOf(values[`${name}.Position`]);
  const r = numbersOf(values[`${name}.Rotation`]);
  return p.length === 3 && r.length === 9 ? { p, r } : null;
}

const frameText = ({ p, r }: { p: number[]; r: number[] }) =>
  [...p, ...orientationOf(r)].join(", ");

const EDITABLE_TYPES = new Set([
  "boolean",
  "number",
  "string",
  "EnumItem",
  "BrickColor",
  "Vector3",
  "Vector3int16",
  "Vector2",
  "Vector2int16",
  "UDim",
  "UDim2",
  "NumberRange",
  "NumberSequence",
  "ColorSequence",
  "Faces",
  "Axes",
  "Rect",
  "Color3",
  "CFrame",
  "PhysicalProperties",
  "Font",
  "Instance",
  "Content",
]);

/** A value from inspect_instance, as the same text the editors and valueFromText use. */
function inspectedText(type: string, value: unknown): string {
  if (typeof value === "string") {
    if (type === "Instance" && value) return value.startsWith("game") ? value : `game.${value}`;
    if (type === "Font") {
      const font = /Family = (.*?), Weight = (\w+), Style = (\w+)/.exec(value);
      if (font) return `${font[1]}, ${font[2]}, ${font[3]}`;
    }
    return value;
  }
  return String(value);
}

function brickColorFields(data: Reflection, fields: ReturnType<typeof toFields>) {
  return fields.map((field) =>
    field.type === "BrickColor"
      ? {
          ...field,
          options: data.brickColors.map(([name]) => name),
          swatches: data.brickColors.map(([, hex]) => hex),
        }
      : field,
  );
}

/** What GetPivot() gives for a part, or a Model without a PrimaryPart. */
function pivotOf(values: Record<string, unknown>) {
  const cframe = frameOf(values, "CFrame");
  const offset = frameOf(values, "PivotOffset");
  return cframe && offset ? multiplyFrames(cframe, offset) : frameOf(values, "WorldPivot");
}

/**
 * A Model with a PrimaryPart takes its pivot from that part, which needs one more read. Null means
 * the part can't be told apart from another at its path, so only a script can say for sure.
 */
async function primaryPartPivotOf(
  callTool: CallStudioTool,
  studioId: string,
  primaryPart: string,
): Promise<{ p: number[]; r: number[] } | null> {
  const result = await callTool("inspect_instance", { studio_id: studioId, path: primaryPart });
  if (mcpError(result)) return null;
  const data = mcpData(result);
  return Array.isArray(data?.matches) ? null : pivotOf(data?.properties ?? {});
}

function detailsFromInspect(
  data: Reflection,
  match: any,
  request: ExplorerDetailsRequest,
  primaryPartPivot: { p: number[]; r: number[] } | null,
): ReturnType<typeof toFields> {
  const values: Record<string, unknown> = match.properties ?? {};
  const chain = classChain(data, request.className);
  const seen = new Set<string>();
  const fields: Record<string, unknown>[] = [];
  const add = (name: string, type: string, text: string, writable: boolean, category: string, enumType?: string | false) => {
    seen.add(name);
    fields.push({
      name,
      value: text,
      type,
      category,
      writable: writable && EDITABLE_TYPES.has(type),
      ...(type === "EnumItem" && enumType && data.enums[enumType] ? { options: data.enums[enumType] } : {}),
    });
  };
  for (const className of chain) {
    for (const [name, type, enumType, writable, category] of data.classes[className][1]) {
      if (seen.has(name)) continue;
      const frame = frameOf(values, name);
      if (frame) {
        add(name, type, frameText(frame), writable, category);
      } else if (values[name] !== undefined) {
        add(name, type, inspectedText(type, values[name]), writable, category, enumType);
      } else if (name === "Parent") {
        const parent = request.path.slice(0, request.path.length - String(match.name ?? "").length - 1);
        add(name, type, parent, writable, category);
      } else if (name === "Position" || name === "Orientation") {
        // These two are the part's CFrame, which is all inspect_instance gives.
        const cframe = frameOf(values, "CFrame");
        if (cframe) add(name, type, (name === "Position" ? cframe.p : orientationOf(cframe.r)).join(", "), writable, category);
      } else if (type === "Instance" || type === "PhysicalProperties") {
        add(name, type, "", writable, category);
      }
    }
  }
  // Without class data there are no types to go on, so what Studio sent is shown as it is.
  if (chain.length === 0) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        add(name, "string", String(value), false, "Data");
      }
    }
  }
  // Where a part or Model moves from, which isn't a property.
  const pivot = primaryPartPivot ?? pivotOf(values);
  if (pivot) add("Pivot", "CFrame", frameText(pivot), true, "Pivot");
  return toFields(fields);
}

/** inspect_instance leaves types out, so a CFrame is the only attribute that says what it is. */
function attributesFromInspect(attributes: unknown) {
  if (!attributes || typeof attributes !== "object") return [];
  return toFields(
    Object.entries(attributes).map(([name, value]: [string, any]) => {
      if (value && typeof value === "object") {
        const frame = { p: numbersOf(value.Position), r: numbersOf(value.Rotation) };
        return { name, value: frameText(frame), type: "CFrame", writable: true };
      }
      if (typeof value === "number") return { name, value: String(value), type: "number", writable: true };
      if (typeof value === "boolean") return { name, value: String(value), type: "boolean", writable: true };
      return { name, value: String(value), type: "string", writable: true };
    }),
  );
}

const HISTORY_STATE_PATH = "CoreGui.BloxBotHistoryState";
const HISTORY_STATE_MAX_AGE_SECONDS = 5;

// Says whether Studio has anything to redo and counts changes to the tree, where inspect_instance
// can read them without a script. It lives in CoreGui, which isn't part of the place: it isn't saved
// and doesn't touch undo history.
const WATCH_HISTORY_LUAU = `local CoreGui = game:GetService("CoreGui")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local previous = CoreGui:FindFirstChild("BloxBotHistoryState")
if previous then previous:Destroy() end
local state = Instance.new("StringValue")
state.Name = "BloxBotHistoryState"
state.Archivable = false
state.Parent = CoreGui
local generation = (_G.__bloxbotHistoryWatch or 0) + 1
_G.__bloxbotHistoryWatch = generation
local visible = { ${[...VISIBLE_SERVICES].map((name) => `${name} = true`).join(", ")} }
local treeVersion = 0
local function noteChange(instance)
  local top = instance
  while top.Parent and top.Parent ~= game do top = top.Parent end
  if visible[top.Name] then treeVersion += 1 end
end
local connections = {
  game.DescendantAdded:Connect(noteChange),
  game.DescendantRemoving:Connect(noteChange),
  game.ItemChanged:Connect(function(instance, property)
    if property == "Name" or property == "Parent" then noteChange(instance) end
  end),
}
task.spawn(function()
  while state.Parent and _G.__bloxbotHistoryWatch == generation do
    state.Value = tostring(ChangeHistoryService:GetCanRedo()) .. " " .. os.time() .. " " .. treeVersion
    task.wait(0.2)
  end
  for _, connection in connections do connection:Disconnect() end
end)
return "ok"`;

type RedoState = "nothing-to-redo" | "can-redo" | "unknown";

/** Null for the tree's version means Studio won't say when the tree changes. */
export async function readHistoryState(
  callTool: CallStudioTool,
  studioId: string,
): Promise<{ redo: RedoState; treeVersion: string | null }> {
  const unknown = { redo: "unknown" as const, treeVersion: null };
  const result = await callTool("inspect_instance", {
    studio_id: studioId,
    path: HISTORY_STATE_PATH,
  });
  if (mcpError(result)) return unknown;
  const state = /^(true|false) (\d+)(?: (\d+))?$/.exec(
    String(mcpData(result)?.properties?.Value ?? ""),
  );
  if (!state) return unknown;
  // A value that stopped updating means the watcher is gone, for example after a plugin reload.
  const age = Math.abs(Date.now() / 1000 - Number(state[2]));
  if (age > HISTORY_STATE_MAX_AGE_SECONDS) return unknown;
  return {
    redo: state[1] === "true" ? "can-redo" : "nothing-to-redo",
    treeVersion: state[3] ?? null,
  };
}

function sortedStrings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string").sort()
    : [];
}

async function readDetailsWithScript(
  callTool: CallStudioTool,
  studioId: string,
  data: Reflection,
  request: ExplorerDetailsRequest,
): Promise<ExplorerNodeDetails> {
  let lastError = "";
  // As with the tree, a playtest rejects "Edit" and may not have a server.
  for (const datamodelType of ["Edit", "Server", "Client"]) {
    const scripted = await callTool("execute_luau", {
      studio_id: studioId,
      datamodel_type: datamodelType,
      code: readDetailsLuau(request),
    });
    const scriptError = mcpError(scripted);
    if (!scriptError) {
      const details = mcpData(scripted);
      return {
        properties: brickColorFields(data, toFields(details?.properties)),
        attributes: brickColorFields(data, toFields(details?.attributes)),
        tags: sortedStrings(details?.tags),
        placeTags: sortedStrings(details?.placeTags),
      };
    }
    lastError = scriptError;
  }
  throw new Error(lastError);
}

/**
 * The tree has names and classes only, so an object's details are read when it's selected. A script
 * reads everything but clears redo, so while Studio has something to redo, this reads what it can
 * without one and says some values are missing.
 */
export async function inspectExplorerNode(
  callTool: CallStudioTool,
  studioId: string,
  request: ExplorerDetailsRequest,
): Promise<ExplorerNodeDetails | null> {
  const { redo, treeVersion } = await readHistoryState(callTool, studioId);
  // Without the watcher there's no telling, and a read nobody asked for shouldn't risk it. What's on
  // screen is better than a note about a redo that may not exist.
  if (redo === "unknown" && request.background) return null;
  let limited: "redo" | "failed" = "redo";
  if (redo !== "can-redo") {
    limited = "failed";
    // A running watcher from an older BloxBot doesn't count changes, and nothing's left to protect.
    if (redo === "unknown" || treeVersion === null) {
      await callTool("execute_luau", {
        studio_id: studioId,
        datamodel_type: "Edit",
        code: WATCH_HISTORY_LUAU,
      });
    }
    try {
      const classData = await reflectionFor(callTool, studioId).catch((error) => {
        // Every value still reads without it. They just can't say their types.
        console.warn("[explorer] couldn't read class data", error);
        return NO_REFLECTION;
      });
      // Class data can take a while, and the user can undo something in Studio meanwhile.
      if ((await readHistoryState(callTool, studioId)).redo !== "can-redo") {
        return await readDetailsWithScript(callTool, studioId, classData, request);
      }
      limited = "redo";
    } catch (error) {
      console.warn("[explorer] couldn't read an object with a script", error);
    }
  }

  const data = loadedReflection ?? NO_REFLECTION;
  const result = await callTool("inspect_instance", { studio_id: studioId, path: request.path });
  const error = mcpError(result);
  if (error) throw new Error(error);
  const inspected = mcpData(result);
  const occurrence = request.occurrence ?? 0;
  const match = Array.isArray(inspected?.matches) ? inspected.matches[occurrence] : inspected;
  // Studio returns up to 20 objects at one path.
  if (!match) {
    const first = inspected?.matches?.[0];
    if (!first) throw new Error("Studio returned unreadable object details");
    return { properties: [], attributes: [], locked: true };
  }
  const hasProperties = Object.keys(match.properties ?? {}).some((name) => name !== "UniqueId");
  const primaryPart = match.properties?.PrimaryPart;
  const primaryPartPivot =
    hasProperties && typeof primaryPart === "string" && primaryPart
      ? await primaryPartPivotOf(callTool, studioId, primaryPart)
      : null;
  if (hasProperties && (!primaryPart || primaryPartPivot)) {
    return {
      properties: brickColorFields(
        data,
        detailsFromInspect(data, match, request, primaryPartPivot),
      ),
      attributes: attributesFromInspect(match.attributes),
      limited,
    };
  }
  // Only a script can read this, like any service. Asked for by hand, that's worth a redo.
  if (request.background) return null;
  return readDetailsWithScript(callTool, studioId, data, request);
}

// Text back into a value, for the type the field holds. Untouched digits arrive exactly as they were
// read, so a CFrame whose orientation wasn't edited keeps its exact rotation. A CFrame's rotation
// and an attribute's type always come from the live value.
export const VALUE_FROM_TEXT_LUAU = `local function doesNotFit() error("That value doesn't fit this field") end
local function numbersIn(text, count)
  local numbers = {}
  for word in string.gmatch(text, "[^%s,;{}%[%]()]+") do
    local number = tonumber(word)
    if number == nil then doesNotFit() end
    table.insert(numbers, number)
  end
  if count and #numbers ~= count then doesNotFit() end
  return table.unpack(numbers)
end
local function objectAt(path)
  if path == "game" then return game end
  local found = {}
  local function look(parent, rest)
    for _, child in parent:GetChildren() do
      if child.Name == rest then table.insert(found, child) end
      if string.sub(rest, 1, #child.Name + 1) == child.Name .. "." then
        look(child, string.sub(rest, #child.Name + 2))
      end
    end
  end
  look(game, (string.gsub(path, "^game%.", "")))
  if #found ~= 1 then doesNotFit() end
  return found[1]
end
local function wordsIn(text)
  local words = {}
  for word in string.gmatch(text, "[%w_]+") do table.insert(words, word) end
  return words
end
local function enumItemsNamed(enum, text)
  local items = {}
  for _, word in wordsIn(text) do
    local item = (enum :: any):FromName(word)
    if item == nil then doesNotFit() end
    table.insert(items, item)
  end
  return items
end
local function keypoints(text, size)
  local numbers = { numbersIn(text) }
  if #numbers == 0 or #numbers % size ~= 0 then doesNotFit() end
  return numbers
end
local FROM_TEXT = {
  string = function(_, text) return text end,
  number = function(_, text) return numbersIn(text, 1) end,
  boolean = function(_, text)
    if text == "true" then return true end
    if text == "false" then return false end
    doesNotFit()
  end,
  EnumItem = function(current, text)
    local itemName = string.match(text, "([^.]+)$")
    for _, item in current.EnumType:GetEnumItems() do
      if item.Name == itemName then return item end
    end
    doesNotFit()
  end,
  BrickColor = function(_, text)
    local color = BrickColor.new(text)
    -- BrickColor.new falls back to grey for a name it doesn't know.
    if color.Name ~= text then doesNotFit() end
    return color
  end,
  Vector3 = function(_, text) return Vector3.new(numbersIn(text, 3)) end,
  Vector3int16 = function(_, text) return Vector3int16.new(numbersIn(text, 3)) end,
  Vector2 = function(_, text) return Vector2.new(numbersIn(text, 2)) end,
  Vector2int16 = function(_, text) return Vector2int16.new(numbersIn(text, 2)) end,
  Color3 = function(_, text) return Color3.new(numbersIn(text, 3)) end,
  UDim = function(_, text) return UDim.new(numbersIn(text, 2)) end,
  UDim2 = function(_, text) return UDim2.new(numbersIn(text, 4)) end,
  Rect = function(_, text) return Rect.new(numbersIn(text, 4)) end,
  NumberRange = function(_, text) return NumberRange.new(numbersIn(text, 2)) end,
  CFrame = function(current, text)
    local px, py, pz, rx, ry, rz = numbersIn(text, 6)
    local position = CFrame.new(px, py, pz)
    if current then
      local cx, cy, cz = current:ToOrientation()
      -- The text may come from another reader, so it can differ in its last digits.
      if math.abs(math.deg(cx) - rx) < 1e-3 and math.abs(math.deg(cy) - ry) < 1e-3 and math.abs(math.deg(cz) - rz) < 1e-3 then
        return position * current.Rotation
      end
    end
    return position * CFrame.fromOrientation(math.rad(rx), math.rad(ry), math.rad(rz))
  end,
  PhysicalProperties = function(_, text)
    if text == "" then return nil end
    return PhysicalProperties.new(numbersIn(text, 6))
  end,
  NumberSequence = function(_, text)
    local numbers = keypoints(text, 3)
    local points = {}
    for index = 1, #numbers, 3 do
      table.insert(points, NumberSequenceKeypoint.new(numbers[index], numbers[index + 1], numbers[index + 2]))
    end
    return NumberSequence.new(points)
  end,
  ColorSequence = function(_, text)
    local numbers = keypoints(text, 5)
    local points = {}
    for index = 1, #numbers, 5 do
      local color = Color3.new(numbers[index + 1], numbers[index + 2], numbers[index + 3])
      table.insert(points, ColorSequenceKeypoint.new(numbers[index], color))
    end
    return ColorSequence.new(points)
  end,
  Faces = function(_, text) return Faces.new(table.unpack(enumItemsNamed(Enum.NormalId, text))) end,
  Axes = function(_, text) return Axes.new(table.unpack(enumItemsNamed(Enum.Axis, text))) end,
  Font = function(_, text)
    local family, weight, style = string.match(text, "^%s*(.-)%s*,%s*(%w+)%s*,%s*(%w+)%s*$")
    if not family then doesNotFit() end
    return Font.new(family, (Enum.FontWeight :: any):FromName(weight), (Enum.FontStyle :: any):FromName(style))
  end,
  Instance = function(_, text)
    if text == "" then return nil end
    return objectAt(text)
  end,
  Content = function(_, text)
    if text == "" then return Content.none end
    return Content.fromUri(text)
  end,
  SecurityCapabilities = function(_, text)
    return SecurityCapabilities.new(table.unpack(enumItemsNamed(Enum.SecurityCapability, text)))
  end,
}
local function valueFromText(kind, current, text)
  local convert = FROM_TEXT[kind]
  if not convert then error("BloxBot can't edit this kind of value") end
  return convert(current, text)
end`;

const STRUCTURE_GUARD_LUAU = `if instance.Parent == game then error("Services can't be changed") end
`;

const ATTRIBUTE_DEFAULTS: Record<AttributeType, string> = {
  string: '""',
  boolean: "false",
  number: "0",
  Vector3: "Vector3.zero",
  Vector2: "Vector2.zero",
  Color3: "Color3.new(1, 1, 1)",
  BrickColor: 'BrickColor.new("Medium stone grey")',
  CFrame: "CFrame.new()",
  UDim: "UDim.new()",
  UDim2: "UDim2.new()",
  NumberRange: "NumberRange.new(0, 1)",
  Rect: "Rect.new(0, 0, 1, 1)",
  NumberSequence: "NumberSequence.new(0)",
  ColorSequence: "ColorSequence.new(Color3.new(1, 1, 1))",
};

const KEEP_NAME_LUAU = "local name = instance.Name";

const EDIT_LUAU: Record<ExplorerEdit["action"], (edit: any) => string> = {
  rename: ({ name }) => `${STRUCTURE_GUARD_LUAU}instance.Name = ${JSON.stringify(name)}
${KEEP_NAME_LUAU}`,
  // A duplicate needs its own name: the tree shows objects sharing a path as one row.
  duplicate: () => `${STRUCTURE_GUARD_LUAU}local copy = instance:Clone()
if not copy then error("This object can't be duplicated") end
-- Roblox allows 100 characters, so a long name gives way to what makes this one different.
local function withSuffix(suffix)
  local stop = utf8.offset(instance.Name, 101 - #suffix)
  return (stop and string.sub(instance.Name, 1, stop - 1) or instance.Name) .. suffix
end
local name = withSuffix("Copy")
local number = 1
while instance.Parent:FindFirstChild(name) do
  number += 1
  name = withSuffix("Copy" .. number)
end
copy.Name = name
copy.Parent = instance.Parent`,
  // Not Destroy(), which locks the object for good, so Studio's undo can put it back.
  delete: () => `${STRUCTURE_GUARD_LUAU}${KEEP_NAME_LUAU}
instance.Parent = nil`,
  setField: ({ kind, field, value, valueType }) => {
    const fieldName = JSON.stringify(field);
    const type = JSON.stringify(valueType);
    const text = JSON.stringify(value);
    const write =
      kind === "attribute"
        ? `local current = instance:GetAttribute(${fieldName})
if current == nil then error("This attribute is gone") end
instance:SetAttribute(${fieldName}, valueFromText(typeof(current), current, ${text}))`
        : field === "Pivot"
          ? `if instance:IsA("PVInstance") then
  instance:PivotTo(valueFromText("CFrame", instance:GetPivot(), ${text}))
else
  error("This object has no pivot")
end`
          : `instance[${fieldName}] = valueFromText(${type}, instance[${fieldName}], ${text})`;
    return `${VALUE_FROM_TEXT_LUAU}
${write}
${KEEP_NAME_LUAU}`;
  },
  addAttribute: ({ field, valueType }: { field: string; valueType: AttributeType }) => {
    const fieldName = JSON.stringify(field);
    return `if instance:GetAttribute(${fieldName}) ~= nil then error("This attribute already exists") end
instance:SetAttribute(${fieldName}, ${ATTRIBUTE_DEFAULTS[valueType]})
${KEEP_NAME_LUAU}`;
  },
  removeAttribute: ({ field }) => `instance:SetAttribute(${JSON.stringify(field)}, nil)
${KEEP_NAME_LUAU}`,
  addTag: ({ field }) => `instance:AddTag(${JSON.stringify(field)})
${KEEP_NAME_LUAU}`,
  removeTag: ({ field }) => `instance:RemoveTag(${JSON.stringify(field)})
${KEEP_NAME_LUAU}`,
};

/** Runs as one call, which Studio records as a change. A playtest's changes wouldn't last, so it's Edit only. */
export async function editExplorerObject(
  callTool: CallStudioTool,
  studioId: string,
  edit: ExplorerEdit,
): Promise<ExplorerEditResult> {
  const result = await callTool("execute_luau", {
    studio_id: studioId,
    datamodel_type: "Edit",
    code: `${findObjectLuau(edit)}
${EDIT_LUAU[edit.action](edit)}
return game:GetService("HttpService"):JSONEncode({ name = name })`,
  });
  const error = mcpError(result);
  if (error) {
    throw new Error(/not available in \w+ mode/i.test(error) ? "Stop the playtest first" : error);
  }
  const name = mcpData(result)?.name;
  if (typeof name !== "string") throw new Error("Studio returned an unreadable answer");
  return { name };
}
