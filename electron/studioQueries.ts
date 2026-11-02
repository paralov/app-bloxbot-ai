import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { ExplorerSnapshot } from "../src/lib/explorer";
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
  const data = mcpData(await callTool("list_roblox_studios", {})) ?? {};
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

async function readGameTree(callTool: CallStudioTool, studioId: string): Promise<any> {
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
    if (!error) return mcpData(result);
    errors.push([datamodelType, error]);
  }
  // Attempts that only say a data model "is not available in … mode" add nothing.
  const [[, first] = ["", ""], ...rest] = errors;
  const details = rest
    .filter(([, error]) => error !== first && !/not available in \w+ mode/i.test(error))
    .map(([type, error]) => `${type.toLowerCase()} data model: ${error}`);
  throw new Error(details.length > 0 ? `${first} (${details.join("; ")})` : first);
}

export async function readExplorerSnapshot(
  callTool: CallStudioTool,
  studioId: string,
): Promise<ExplorerSnapshot> {
  const raw = await readGameTree(callTool, studioId);
  const rows: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.instances) ? raw.instances : [];
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
  return { placeName, capturedAt: new Date().toISOString(), roots };
}
