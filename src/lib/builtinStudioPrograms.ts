import type { ExplorerProgramEnvelope } from "@/lib/explorer";
import type { StudioTargetProgramEnvelopes } from "@/types/studioTarget";

const NORMALIZE_MCP_RESULT = `
function normalizeMcpResult(result: unknown): any {
  const content = result && typeof result === "object" && !Array.isArray(result)
    ? (result as any).content
    : result;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as any).type === "json") return (part as any).json;
      if ((part as any).type === "text" && typeof (part as any).text === "string") {
        return parseMcpText((part as any).text);
      }
    }
  }
  if (typeof content === "string") return parseMcpText(content);
  return content;
}

// Studio MCP can put a note such as "Note: Output limited to N nodes" before
// the JSON, so fall back to parsing from the first bracket.
function parseMcpText(text: string): any {
  try { return JSON.parse(text); } catch {}
  const starts = [text.indexOf("["), text.indexOf("{")].filter((index) => index > 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start > 0) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  return text;
}

function mcpErrorText(result: unknown): string | null {
  if (!result || typeof result !== "object" || (result as any).isError !== true) return null;
  const content = (result as any).content;
  const text = Array.isArray(content)
    ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join(" ").trim()
    : "";
  return text || "Studio returned an error";
}

function normalizeMcpIdentifier(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}`;

const targetDiscoverySource = `
${NORMALIZE_MCP_RESULT}
async function run({ callTool }: { input: unknown; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data) ? data : Array.isArray(data.studios) ? data.studios : [];
  const targets = studios.flatMap((studio: any) => {
    const rawStudioId = studio?.studio_id ?? studio?.studioId ?? studio?.id;
    const key = normalizeMcpIdentifier(rawStudioId) ?? "";
    if (!key) return [];
    const rawPlaceId = studio?.place_id ?? studio?.placeId;
    const placeId = normalizeMcpIdentifier(rawPlaceId);
    const rawLabel = studio?.name ?? studio?.place_name ?? studio?.placeName;
    return [{
      key,
      label: typeof rawLabel === "string" && rawLabel ? rawLabel : key,
      detail: placeId ? "Place " + placeId : "Local place",
      placeId,
    }];
  });
  return { targets, selectedKey: null };
}`;

const targetSelectionSource = `
${NORMALIZE_MCP_RESULT}
async function run({ input, callTool }: { input: any; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const targetKey = typeof input?.targetKey === "string" ? input.targetKey : "";
  if (!targetKey) throw new Error("A Studio target is required");
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data) ? data : Array.isArray(data.studios) ? data.studios : [];
  const selected = studios.find((studio: any) => {
    const rawStudioId = studio?.studio_id ?? studio?.studioId ?? studio?.id;
    return normalizeMcpIdentifier(rawStudioId) === targetKey;
  });
  if (!selected) throw new Error("Studio target could not be verified");
  const rawPlaceId = selected?.place_id ?? selected?.placeId;
  const placeId = normalizeMcpIdentifier(rawPlaceId);
  const rawLabel = selected?.name ?? selected?.place_name ?? selected?.placeName;
  return {
    selected: {
      key: targetKey,
      label: typeof rawLabel === "string" && rawLabel ? rawLabel : targetKey,
      detail: placeId ? "Place " + placeId : "Local place",
      placeId,
    },
    verified: true,
  };
}`;

export const BUILTIN_STUDIO_TARGET_PROGRAMS: StudioTargetProgramEnvelopes = {
  discovery: {
    version: 1,
    contract: {
      name: "studio-target-discovery",
      version: "1",
      inputSchemaVersion: "1",
      outputSchemaVersion: "1",
    },
    source: targetDiscoverySource,
  },
  selection: {
    version: 1,
    contract: {
      name: "studio-target-selection",
      version: "1",
      inputSchemaVersion: "1",
      outputSchemaVersion: "1",
    },
    source: targetSelectionSource,
  },
};

const explorerSource = `
${NORMALIZE_MCP_RESULT}
async function run({ input, callTool }: { input: { studioId: string }; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const studioId = typeof input?.studioId === "string" ? input.studioId : "";
  if (!studioId) throw new Error("A Studio target is required");
  // Studio caps max_depth at 10; use that ceiling and a generous result cap so
  // ordinary places are collected in one pass. Studio requires datamodel_type:
  // "Edit" normally, and it rejects "Edit" during a playtest, so fall back to
  // the server data model then.
  let raw: any = null;
  let lastError = "";
  for (const datamodelType of ["Edit", "Server"]) {
    const result = await callTool("search_game_tree", {
      studio_id: studioId,
      datamodel_type: datamodelType,
      max_depth: 10,
      head_limit: 100000,
    });
    const error = mcpErrorText(result);
    if (error) {
      lastError = error;
      continue;
    }
    raw = normalizeMcpResult(result);
    break;
  }
  if (raw === null) throw new Error(lastError || "Studio did not return an instance tree");
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.instances) ? raw.instances : [];
  // Match Studio Explorer's default service set. Studio hides less commonly
  // edited engine services unless the user explicitly enables them.
  const visibleServices = new Set([
    "Workspace", "Players", "Lighting", "MaterialService", "ReplicatedFirst",
    "ReplicatedStorage", "ServerScriptService", "ServerStorage", "StarterGui",
    "StarterPack", "StarterPlayer", "Teams", "SoundService", "TextChatService",
  ]);
  const byPath = new Map<string, any>();
  let placeName = "Roblox Studio";
  for (const row of rows) {
    if (row?.className === "DataModel" && typeof row?.name === "string" && row.name) {
      placeName = row.name;
      continue;
    }
    const path = typeof row?.fullPath === "string" ? row.fullPath : typeof row?.path === "string" ? row.path : "";
    if (!path) continue;
    const topLevel = path.split(".")[0];
    if (!visibleServices.has(topLevel)) continue;
    const properties = row?.properties && typeof row.properties === "object" ? row.properties : {};
    const instanceName =
      typeof properties.Name === "string" && properties.Name ? properties.Name :
      typeof row.Name === "string" && row.Name ? row.Name :
      typeof row.name === "string" && row.name ? row.name :
      path.split(".").at(-1) ?? path;
    byPath.set(path, {
      name: instanceName,
      className: typeof row.className === "string" ? row.className : "Instance",
      path: path.startsWith("game.") ? path : "game." + path,
      hasChildren: Number(row.unexploredChildCount ?? 0) > 0,
      properties: [], attributes: [], children: [],
    });
  }
  const roots: any[] = [];
  for (const [path, node] of byPath) {
    const parentPath = path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : "";
    const parent = byPath.get(parentPath);
    if (parent) { parent.children.push(node); parent.hasChildren = true; }
    else roots.push(node);
  }
  return { placeName, capturedAt: new Date().toISOString(), roots };
}`;

export const BUILTIN_EXPLORER_PROGRAM: ExplorerProgramEnvelope = {
  version: 1,
  contract: {
    name: "explorer-snapshot",
    version: "1",
    inputSchemaVersion: "explorer-input-v1",
    outputSchemaVersion: "explorer-snapshot-v1",
  },
  source: explorerSource,
};
