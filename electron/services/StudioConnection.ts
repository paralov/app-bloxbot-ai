import { type Systeminformation, networkConnections } from "systeminformation";

type NetworkConnection = Pick<
  Systeminformation.NetworkConnectionsData,
  "localAddress" | "localPort" | "peerPort" | "process" | "protocol" | "state"
>;

function processName(process: string): string {
  return process.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function isStudioMcp(process: string): boolean {
  return /^studiomcp(?:\.exe)?$/.test(processName(process));
}

function isRobloxStudio(process: string): boolean {
  return /^robloxstudio(?:beta)?(?:\.exe)?$/.test(processName(process));
}

export function hasStudioMcpConnection(connections: readonly NetworkConnection[]): boolean {
  const studioMcpPorts = new Set(
    connections
      .filter(
        (connection) =>
          connection.protocol.startsWith("tcp") &&
          connection.state.startsWith("LISTEN") &&
          isStudioMcp(connection.process),
      )
      .map((connection) => connection.localPort),
  );

  return connections.some(
    (connection) =>
      connection.protocol.startsWith("tcp") &&
      connection.state === "ESTABLISHED" &&
      isRobloxStudio(connection.process) &&
      (studioMcpPorts.has(connection.localPort) || studioMcpPorts.has(connection.peerPort)),
  );
}

export async function isStudioConnected(): Promise<boolean> {
  try {
    return hasStudioMcpConnection(await networkConnections());
  } catch {
    return false;
  }
}
