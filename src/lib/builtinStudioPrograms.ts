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
        try { return JSON.parse((part as any).text); } catch { return (part as any).text; }
      }
    }
  }
  if (typeof content === "string") {
    try { return JSON.parse(content); } catch { return content; }
  }
  return content;
}`;

const targetDiscoverySource = `
${NORMALIZE_MCP_RESULT}
async function run({ callTool }: { input: unknown; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data.studios) ? data.studios : [];
  const targets = studios.flatMap((studio: any) => {
    const key = typeof studio?.id === "string" ? studio.id : "";
    if (!key) return [];
    return [{
      key,
      label: typeof studio.name === "string" && studio.name ? studio.name : key,
      detail: studio.active === true ? "Active" : null,
    }];
  });
  const active = studios.find((studio: any) => studio?.active === true);
  return { targets, selectedKey: typeof active?.id === "string" ? active.id : null };
}`;

const targetSelectionSource = `
${NORMALIZE_MCP_RESULT}
async function run({ input, callTool }: { input: any; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  const targetKey = typeof input?.targetKey === "string" ? input.targetKey : "";
  if (!targetKey) throw new Error("A Studio target is required");
  await callTool("set_active_studio", { studio_id: targetKey });
  const data = normalizeMcpResult(await callTool("list_roblox_studios", {})) ?? {};
  const studios = Array.isArray(data.studios) ? data.studios : [];
  const selected = studios.find((studio: any) => studio?.id === targetKey && studio?.active === true);
  if (!selected) throw new Error("Studio target could not be verified");
  return {
    selected: {
      key: targetKey,
      label: typeof selected.name === "string" && selected.name ? selected.name : targetKey,
      detail: "Active",
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
async function run({ callTool }: { input: unknown; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) {
  // Studio currently caps max_depth at 10. Use that ceiling and an intentionally
  // generous result cap so ordinary places are collected in one pass.
  const raw = normalizeMcpResult(await callTool("search_game_tree", { max_depth: 10, head_limit: 100000 }));
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.instances) ? raw.instances : [];
  const byPath = new Map<string, any>();
  for (const row of rows) {
    const path = typeof row?.fullPath === "string" ? row.fullPath : typeof row?.path === "string" ? row.path : "";
    if (!path) continue;
    byPath.set(path, {
      name: typeof row.name === "string" ? row.name : path.split(".").at(-1) ?? path,
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
  return { placeName: "Roblox Studio", capturedAt: new Date().toISOString(), roots };
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
