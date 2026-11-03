import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ExplorerNodeDetails, ExplorerSnapshot } from "../src/lib/explorer";
import type { StudioTarget, StudioTargetDiscovery, StudioTargetSelection } from "../src/types/studioTarget";

export type CallStudioTool = (
  name: string,
  args: Record<string, unknown>,
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

function mcpData(result: CallToolResult): any {
  for (const part of result.content ?? []) {
    if ((part as any).type === "json") return (part as any).json;
    if (part.type === "text") return parseMcpText(part.text);
  }
  return null;
}

function mcpError(result: CallToolResult): string | null {
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
  const placeId = identifier(studio?.place_id ?? studio?.placeId);
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
const VISIBLE_SERVICES = new Set([
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

async function readGameTree(
  callTool: CallStudioTool,
  studioId: string,
): Promise<{ data: any; truncated: boolean }> {
  // Studio caps max_depth at 10; use that ceiling and a generous result cap so
  // ordinary places are collected in one pass. Studio requires datamodel_type:
  // "Edit" normally, and it rejects "Edit" during a playtest, so fall back to
  // the server data model then, and to the client one when Studio can't reach
  // the server (Play Solo on recent Studio builds).
  const errors: Array<[string, string]> = [];
  for (const datamodelType of ["Edit", "Server", "Client"]) {
    const result = await callTool("search_game_tree", {
      studio_id: studioId,
      datamodel_type: datamodelType,
      max_depth: 10,
      head_limit: 100000,
    });
    const error = mcpError(result);
    if (!error) {
      const truncated = (result.content ?? []).some(
        (part) => part.type === "text" && /^Note: Output limited/.test(part.text),
      );
      return { data: mcpData(result), truncated };
    }
    errors.push([datamodelType, error]);
  }
  // Attempts that only say a data model "is not available in … mode" add nothing.
  const [[, first] = ["", ""], ...rest] = errors;
  const details = rest
    .filter(([, error]) => error !== first && !/not available in \w+ mode/i.test(error))
    .map(([type, error]) => `${type.toLowerCase()} data model: ${error}`);
  throw new Error(details.length > 0 ? `${first} (${details.join("; ")})` : first);
}

function toFields(values: unknown) {
  if (!values || typeof values !== "object") return [];
  return Object.entries(values)
    .filter(([, value]) => value !== null && typeof value !== "object")
    .map(([name, value]) => ({ name, value: String(value) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A Lua empty table arrives as [], so that also means no fields. */
function isFieldTable(value: unknown) {
  return (
    typeof value === "object" && value !== null && (!Array.isArray(value) || value.length === 0)
  );
}

// Object names come from the place, so the path goes in JSON-encoded. This only reads.
function readPropertiesLuau(path: string) {
  return `local instance = game
for name in string.gmatch(${JSON.stringify(path.replace(/^game\./, ""))}, "[^.]+") do
  instance = instance:FindFirstChild(name)
  if not instance then error("Object not found") end
end
local values = {}
for _, property in game:GetService("ReflectionService"):GetPropertiesOfClass(instance.ClassName) do
  -- Lowercase names are deprecated aliases, like archivable for Archivable.
  if string.match(property.Name, "^%u") and property.Name ~= "ClassName" then
    local ok, value = pcall(function() return instance[property.Name] end)
    if ok and value ~= nil then values[property.Name] = tostring(value) end
  end
end
return game:GetService("HttpService"):JSONEncode(values)`;
}

async function readPropertiesWithLuau(callTool: CallStudioTool, studioId: string, path: string) {
  let lastError = "";
  // As with the tree, a playtest rejects "Edit" and may not have a server.
  for (const datamodelType of ["Edit", "Server", "Client"]) {
    const result = await callTool("execute_luau", {
      studio_id: studioId,
      datamodel_type: datamodelType,
      code: readPropertiesLuau(path),
    });
    const error = mcpError(result);
    if (!error) return toFields(mcpData(result));
    lastError = error;
  }
  throw new Error(lastError);
}

/** The tree has names and classes only, so an object's details are read when it's selected. */
export async function inspectExplorerNode(
  callTool: CallStudioTool,
  studioId: string,
  path: string,
): Promise<ExplorerNodeDetails> {
  const result = await callTool("inspect_instance", { studio_id: studioId, path });
  const error = mcpError(result);
  if (error) throw new Error(error);
  const data = mcpData(result);
  // Objects sharing a path come back as matches, and the tree shows them as one row.
  const details = Array.isArray(data?.matches) ? data.matches[0] : data;
  if (
    !isFieldTable(details?.properties) ||
    (details.attributes != null && !isFieldTable(details.attributes))
  ) {
    throw new Error("Studio returned unreadable object details");
  }
  const properties = toFields(details.properties);
  return {
    // inspect_instance reads nothing for services and Terrain.
    properties:
      properties.length > 0 ? properties : await readPropertiesWithLuau(callTool, studioId, path),
    attributes: toFields(details.attributes),
  };
}

export async function readExplorerSnapshot(
  callTool: CallStudioTool,
  studioId: string,
): Promise<ExplorerSnapshot> {
  const { data: raw, truncated } = await readGameTree(callTool, studioId);
  const rows: any[] = Array.isArray(raw) ? raw : raw?.instances;
  if (!Array.isArray(rows)) throw new Error("Studio returned an unreadable instance tree");
  const byPath = new Map<string, any>();
  let placeName = "Roblox Studio";
  for (const row of rows) {
    if (row?.className === "DataModel" && typeof row?.name === "string" && row.name) {
      placeName = row.name;
      continue;
    }
    const path =
      typeof row?.fullPath === "string" ? row.fullPath : typeof row?.path === "string" ? row.path : "";
    if (!path || !VISIBLE_SERVICES.has(path.split(".")[0])) continue;
    const properties = row.properties && typeof row.properties === "object" ? row.properties : {};
    const name = [properties.Name, row.Name, row.name].find(
      (candidate) => typeof candidate === "string" && candidate,
    );
    byPath.set(path, {
      name: name ?? path.split(".").at(-1) ?? path,
      className: typeof row.className === "string" ? row.className : "Instance",
      path: path.startsWith("game.") ? path : `game.${path}`,
      hasChildren: Number(row.unexploredChildCount ?? 0) > 0,
      properties: [],
      attributes: [],
      children: [],
    });
  }
  const roots: any[] = [];
  for (const [path, node] of byPath) {
    const parent = path.includes(".") ? byPath.get(path.slice(0, path.lastIndexOf("."))) : undefined;
    if (parent) {
      parent.children.push(node);
      parent.hasChildren = true;
    } else {
      roots.push(node);
    }
  }
  return { placeName, capturedAt: new Date().toISOString(), roots, truncated };
}
