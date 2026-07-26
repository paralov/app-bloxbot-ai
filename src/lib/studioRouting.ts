import type {
  McpLocalConfig,
  OpencodeClient,
  PermissionRule,
  PermissionRuleset,
} from "@opencode-ai/sdk/v2/client";

import type { StudioAssignment } from "@/types/desktop";

const BASE_SERVER = "roblox-studio";
const ROUTER_TEMPLATE = "bloxbot-studio-router-template";
const SESSION_PREFIX = "bloxbot_studio_";

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
const sessionPrefix = (sessionID: string) => `${SESSION_PREFIX}${safeName(sessionID)}_`;

export function studioSessionServerName(sessionID: string, studioID: string): string {
  return `${sessionPrefix(sessionID)}${safeName(studioID)}`;
}

function localConfig(value: unknown): value is McpLocalConfig {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "local" &&
      "command" in value &&
      Array.isArray(value.command),
  );
}

async function ensureServer(client: OpencodeClient, name: string, studioID: string): Promise<void> {
  const current = (await client.mcp.status({}, { throwOnError: true })).data?.[name];
  if (current?.status === "connected") return;

  if (current) {
    await client.mcp.connect({ name }, { throwOnError: true });
  } else {
    const mcp = (await client.config.get({}, { throwOnError: true })).data?.mcp;
    const base = mcp?.[BASE_SERVER];
    const router = mcp?.[ROUTER_TEMPLATE];
    if (!localConfig(base) || !localConfig(router))
      throw new Error("Studio routing is unavailable");
    await client.mcp.add(
      {
        name,
        config: {
          ...router,
          command: [...router.command, "--studio-id", studioID, "--", ...base.command],
          environment: { ...base.environment, ...router.environment },
          enabled: true,
        },
      },
      { throwOnError: true },
    );
  }

  const status = (await client.mcp.status({}, { throwOnError: true })).data?.[name];
  if (status?.status !== "connected") {
    throw new Error(status && "error" in status ? status.error : "Studio routing failed");
  }
}

const studioTool = (name: string) =>
  name.startsWith(`${BASE_SERVER}_`) || name.startsWith(SESSION_PREFIX);

async function setStudioPermissions(
  client: OpencodeClient,
  sessionID: string,
  enabledPrefix: string,
): Promise<void> {
  const [tools, session] = await Promise.all([
    client.tool.ids({}, { throwOnError: true }),
    client.session.get({ sessionID }, { throwOnError: true }),
  ]);
  if (!session.data) throw new Error("The active session is unavailable");

  const permissions: PermissionRuleset = [
    ...(session.data.permission ?? []).filter(
      (rule: PermissionRule) => !studioTool(rule.permission),
    ),
    ...(tools.data ?? []).filter(studioTool).map((permission) => ({
      permission,
      pattern: "*",
      action: permission.startsWith(enabledPrefix) ? ("allow" as const) : ("deny" as const),
    })),
  ];
  if (JSON.stringify(permissions) !== JSON.stringify(session.data.permission ?? [])) {
    await client.session.update({ sessionID, permission: permissions }, { throwOnError: true });
  }
}

export async function routeAutomaticStudio(
  client: OpencodeClient,
  sessionID: string,
): Promise<void> {
  await setStudioPermissions(client, sessionID, `${BASE_SERVER}_`);
}

export async function routeAssignedStudio(
  client: OpencodeClient,
  sessionID: string,
  assignment: StudioAssignment,
): Promise<string> {
  const server = studioSessionServerName(sessionID, assignment.id);
  await ensureServer(client, server, assignment.id);
  await setStudioPermissions(client, sessionID, `${server}_`);
  return `This session is pinned to ${JSON.stringify(assignment.name)} (${JSON.stringify(assignment.id)}). Use only ${server}_ Studio tools. If they fail, ask the user to reassign the session.`;
}

export async function disconnectSessionStudioServer(
  client: OpencodeClient,
  sessionID: string,
): Promise<void> {
  const status = (await client.mcp.status({}, { throwOnError: true })).data ?? {};
  await Promise.all(
    Object.entries(status)
      .filter(
        ([name, value]) => name.startsWith(sessionPrefix(sessionID)) && value.status !== "disabled",
      )
      .map(([name]) => client.mcp.disconnect({ name }, { throwOnError: true })),
  );
}
