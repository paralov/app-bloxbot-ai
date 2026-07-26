import type {
  McpLocalConfig,
  OpencodeClient,
  PermissionRule,
  PermissionRuleset,
} from "@opencode-ai/sdk/v2/client";

import {
  BASE_STUDIO_MCP_NAME,
  SESSION_STUDIO_PREFIX,
  STUDIO_ROUTER_TEMPLATE_MCP_NAME,
} from "@/lib/studioRoutingNames";
import type { StudioAssignment } from "@/types/desktop";

const setupPromises = new WeakMap<object, Map<string, Promise<void>>>();

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function studioSessionServerPrefix(sessionID: string): string {
  return `${SESSION_STUDIO_PREFIX}${sanitizeName(sessionID)}_${stableHash(sessionID)}_`;
}

export function studioSessionServerName(sessionID: string, studioID: string): string {
  return `${studioSessionServerPrefix(sessionID)}${sanitizeName(studioID)}_${stableHash(studioID)}`;
}

function isLocalMcpConfig(value: unknown): value is McpLocalConfig {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "local" &&
    "command" in value &&
    Array.isArray(value.command)
  );
}

async function connectSessionStudioServer(
  client: OpencodeClient,
  serverName: string,
  studioID: string,
): Promise<void> {
  const statusResponse = await client.mcp.status({}, { throwOnError: true });
  const currentStatus = statusResponse.data?.[serverName];
  if (currentStatus?.status === "connected") return;

  if (currentStatus) {
    await client.mcp.connect({ name: serverName }, { throwOnError: true });
  } else {
    const configResponse = await client.config.get({}, { throwOnError: true });
    const baseConfig = configResponse.data?.mcp?.[BASE_STUDIO_MCP_NAME];
    const routerConfig = configResponse.data?.mcp?.[STUDIO_ROUTER_TEMPLATE_MCP_NAME];
    if (!isLocalMcpConfig(baseConfig) || !isLocalMcpConfig(routerConfig)) {
      throw new Error("The Roblox Studio routing configuration is unavailable");
    }

    await client.mcp.add(
      {
        name: serverName,
        config: {
          ...routerConfig,
          command: [...routerConfig.command, "--studio-id", studioID, "--", ...baseConfig.command],
          environment: { ...baseConfig.environment, ...routerConfig.environment },
          enabled: true,
        },
      },
      { throwOnError: true },
    );
  }

  const refreshed = await client.mcp.status({}, { throwOnError: true });
  const refreshedStatus = refreshed.data?.[serverName];
  if (refreshedStatus?.status !== "connected") {
    const detail =
      refreshedStatus && "error" in refreshedStatus
        ? refreshedStatus.error
        : (refreshedStatus?.status ?? "missing");
    throw new Error(`The assigned Roblox Studio connection failed (${detail})`);
  }
}

async function ensureSessionStudioServer(
  client: OpencodeClient,
  serverName: string,
  studioID: string,
): Promise<void> {
  let clientSetups = setupPromises.get(client);
  if (!clientSetups) {
    clientSetups = new Map();
    setupPromises.set(client, clientSetups);
  }

  const existing = clientSetups.get(serverName);
  if (existing) return existing;

  const setup = connectSessionStudioServer(client, serverName, studioID).finally(() => {
    clientSetups?.delete(serverName);
  });
  clientSetups.set(serverName, setup);
  return setup;
}

async function disconnectOtherSessionStudioServers(
  client: OpencodeClient,
  sessionID: string,
  keepServerName: string,
): Promise<void> {
  const response = await client.mcp.status({}, { throwOnError: true });
  const prefix = studioSessionServerPrefix(sessionID);
  await Promise.all(
    Object.entries(response.data ?? {})
      .filter(
        ([name, status]) =>
          name.startsWith(prefix) && name !== keepServerName && status.status !== "disabled",
      )
      .map(([name]) => client.mcp.disconnect({ name }, { throwOnError: true })),
  );
}

function isBloxBotStudioTool(toolID: string): boolean {
  return toolID.startsWith(`${BASE_STUDIO_MCP_NAME}_`) || toolID.startsWith(SESSION_STUDIO_PREFIX);
}

export interface StudioPromptRouting {
  system: string;
  permissions: PermissionRuleset;
}

async function studioToolIDs(client: OpencodeClient): Promise<string[]> {
  const response = await client.tool.ids({}, { throwOnError: true });
  return response.data ?? [];
}

function studioPermissionRules(
  toolAccess: ReadonlyArray<readonly [string, boolean]>,
): PermissionRuleset {
  return toolAccess.map(([permission, enabled]) => ({
    permission,
    pattern: "*",
    action: enabled ? "allow" : "deny",
  }));
}

export async function prepareAutomaticStudioPermissionRouting(
  client: OpencodeClient,
): Promise<PermissionRuleset> {
  return studioPermissionRules(
    (await studioToolIDs(client))
      .filter(isBloxBotStudioTool)
      .map((toolID) => [toolID, toolID.startsWith(`${BASE_STUDIO_MCP_NAME}_`)] as const),
  );
}

function isStudioPermissionRule(rule: PermissionRule): boolean {
  return isBloxBotStudioTool(rule.permission);
}

export async function applyStudioPermissionRouting(
  client: OpencodeClient,
  sessionID: string,
  studioPermissions: PermissionRuleset,
): Promise<void> {
  const response = await client.session.get({ sessionID }, { throwOnError: true });
  if (!response.data) throw new Error("The active OpenCode session is unavailable");

  const permissions = [
    ...(response.data.permission ?? []).filter((rule) => !isStudioPermissionRule(rule)),
    ...studioPermissions,
  ];
  if (JSON.stringify(permissions) === JSON.stringify(response.data.permission ?? [])) return;
  await client.session.update({ sessionID, permission: permissions }, { throwOnError: true });
}

export async function prepareStudioPromptRouting(
  client: OpencodeClient,
  sessionID: string,
  assignment: StudioAssignment,
): Promise<StudioPromptRouting> {
  const serverName = studioSessionServerName(sessionID, assignment.id);
  await disconnectOtherSessionStudioServers(client, sessionID, serverName);
  await ensureSessionStudioServer(client, serverName, assignment.id);

  const assignedPrefix = `${serverName}_`;
  const permissions = studioPermissionRules(
    (await studioToolIDs(client))
      .filter(isBloxBotStudioTool)
      .map((toolID) => [toolID, toolID.startsWith(assignedPrefix)] as const),
  );

  return {
    system: [
      `This BloxBot session is routed to Roblox Studio place ${JSON.stringify(assignment.name)} (${JSON.stringify(assignment.id)}).`,
      `Use only Studio tools beginning with ${assignedPrefix}; never use another Roblox Studio MCP server.`,
      "Place selection is enforced automatically. If routing fails, stop and tell the user to reassign the session.",
    ].join(" "),
    permissions,
  };
}

export async function disconnectSessionStudioServer(
  client: OpencodeClient,
  sessionID: string,
): Promise<void> {
  const response = await client.mcp.status({}, { throwOnError: true });
  const prefix = studioSessionServerPrefix(sessionID);
  await Promise.all(
    Object.entries(response.data ?? {})
      .filter(([name, status]) => name.startsWith(prefix) && status.status !== "disabled")
      .map(([name]) => client.mcp.disconnect({ name }, { throwOnError: true })),
  );
}
