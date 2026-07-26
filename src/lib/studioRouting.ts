import type { McpLocalConfig, OpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { StudioAssignment } from "@/types/desktop";

const BASE_STUDIO_MCP_NAME = "roblox-studio";
const SESSION_STUDIO_PREFIX = "bloxbot_studio_";

const setupPromises = new WeakMap<object, Map<string, Promise<void>>>();

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function studioSessionServerName(sessionID: string): string {
  return `${SESSION_STUDIO_PREFIX}${sanitizeName(sessionID)}`;
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
): Promise<void> {
  const statusResponse = await client.mcp.status({}, { throwOnError: true });
  const currentStatus = statusResponse.data?.[serverName];
  if (currentStatus?.status === "connected") return;

  if (currentStatus) {
    await client.mcp.connect({ name: serverName }, { throwOnError: true });
    return;
  }

  const configResponse = await client.config.get({}, { throwOnError: true });
  const baseConfig = configResponse.data?.mcp?.[BASE_STUDIO_MCP_NAME];
  if (!isLocalMcpConfig(baseConfig)) {
    throw new Error("The Roblox Studio MCP configuration is unavailable");
  }

  await client.mcp.add(
    {
      name: serverName,
      config: { ...baseConfig, enabled: true },
    },
    { throwOnError: true },
  );
}

async function ensureSessionStudioServer(
  client: OpencodeClient,
  serverName: string,
): Promise<void> {
  let clientSetups = setupPromises.get(client);
  if (!clientSetups) {
    clientSetups = new Map();
    setupPromises.set(client, clientSetups);
  }

  const existing = clientSetups.get(serverName);
  if (existing) return existing;

  const setup = connectSessionStudioServer(client, serverName).finally(() => {
    clientSetups?.delete(serverName);
  });
  clientSetups.set(serverName, setup);
  return setup;
}

function isBloxBotStudioTool(toolID: string): boolean {
  return toolID.startsWith(`${BASE_STUDIO_MCP_NAME}_`) || toolID.startsWith(SESSION_STUDIO_PREFIX);
}

export interface StudioPromptRouting {
  system: string;
  tools: Record<string, boolean>;
}

export async function prepareStudioPromptRouting(
  client: OpencodeClient,
  sessionID: string,
  assignment: StudioAssignment,
): Promise<StudioPromptRouting> {
  const serverName = studioSessionServerName(sessionID);
  await ensureSessionStudioServer(client, serverName);

  const toolResponse = await client.tool.ids({}, { throwOnError: true });
  const assignedPrefix = `${serverName}_`;
  const tools = Object.fromEntries(
    (toolResponse.data ?? [])
      .filter(isBloxBotStudioTool)
      .map((toolID) => [toolID, toolID.startsWith(assignedPrefix)]),
  );

  return {
    system: [
      `This BloxBot session is assigned to Roblox Studio instance ${JSON.stringify(assignment.id)}.`,
      `Before the first Studio operation in every response, call ${serverName}_set_active_studio with that studio_id.`,
      `Use only Studio tools beginning with ${assignedPrefix}; never use another Roblox Studio MCP server.`,
      "If the assigned Studio is disconnected or selection fails, stop and tell the user to reassign the session.",
    ].join(" "),
    tools,
  };
}

export async function disconnectSessionStudioServer(
  client: OpencodeClient,
  sessionID: string,
): Promise<void> {
  const serverName = studioSessionServerName(sessionID);
  const response = await client.mcp.status({}, { throwOnError: true });
  if (response.data?.[serverName]?.status === "connected") {
    await client.mcp.disconnect({ name: serverName }, { throwOnError: true });
  }
}
