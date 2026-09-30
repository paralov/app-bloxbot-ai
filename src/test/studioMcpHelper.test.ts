import { describe, expect, it, vi } from "vitest";

import {
  parseContentFolder,
  parseStudioMcpBatPath,
  resolveStudioMcpHelper,
  type StudioMcpHelperProbe,
} from "../../electron/studioMcpHelper";

const LOCAL = "C:\\Users\\Jane Doe\\AppData\\Local";
const BAT = `${LOCAL}\\Roblox\\mcp.bat`;
const VERSIONS = `${LOCAL}\\Roblox\\Versions`;
const environment = { localAppData: LOCAL, comSpec: "C:\\WINDOWS\\system32\\cmd.exe" };

// The mcp.bat Roblox Studio writes, including its misplaced `else` line.
function studioBat(version: string): string {
  const exe = `${VERSIONS}\\${version}\\StudioMCP.exe`;
  return [
    "@echo off",
    `if exist "${exe}" (`,
    `"${exe}" %* )`,
    `else (for /f "tokens=2*" %%A in ('reg query HKEY_CURRENT_USER\\Software\\Roblox\\RobloxStudio /v ContentFolder') do (`,
    `"%%B/..\\StudioMCP.exe" %*`,
    "))",
    "",
  ].join("\r\n");
}

function registryOutput(contentFolder: string): string {
  return [
    "",
    "HKEY_CURRENT_USER\\Software\\Roblox\\RobloxStudio",
    `    ContentFolder    REG_SZ    ${contentFolder}`,
    "",
    "",
  ].join("\r\n");
}

interface FakeDisk {
  files?: Record<string, string>;
  /** Executables and their modification times. */
  exes?: Record<string, number>;
  registry?: string | null;
}

function fakeProbe({ files = {}, exes = {}, registry = null }: FakeDisk): StudioMcpHelperProbe {
  return {
    exists: vi.fn(async (path: string) => path in files || path in exes),
    readText: vi.fn(async (path: string) => files[path] ?? null),
    listDirectory: vi.fn(async (path: string) => {
      const prefix = `${path}\\`;
      const children = [...Object.keys(files), ...Object.keys(exes)]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split("\\")[0] ?? "");
      return [...new Set(children)];
    }),
    modifiedTime: vi.fn(async (path: string) => exes[path] ?? null),
    queryContentFolder: vi.fn(async () => registry),
  };
}

describe("Studio MCP helper on Windows (#106)", () => {
  it("starts the StudioMCP.exe named in mcp.bat directly, even with spaces in the path", async () => {
    const exe = `${VERSIONS}\\version-abc123\\StudioMCP.exe`;
    const probe = fakeProbe({ files: { [BAT]: studioBat("version-abc123") }, exes: { [exe]: 1 } });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toEqual({
      command: [exe],
      installPath: exe,
      source: "bat_path",
    });
    expect(probe.queryContentFolder).not.toHaveBeenCalled();
  });

  it("uses the registry ContentFolder when mcp.bat names a version that's gone", async () => {
    const exe = `${VERSIONS}\\version-new456\\StudioMCP.exe`;
    const probe = fakeProbe({
      files: { [BAT]: studioBat("version-old123") },
      exes: { [exe]: 1 },
      registry: registryOutput(`${VERSIONS}\\version-new456\\content`),
    });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toEqual({
      command: [exe],
      installPath: exe,
      source: "registry",
    });
  });

  it("accepts the forward slashes Studio can write in ContentFolder", async () => {
    const exe = `${VERSIONS}\\version-new456\\StudioMCP.exe`;
    const probe = fakeProbe({
      exes: { [exe]: 1 },
      registry: registryOutput(`${VERSIONS.replaceAll("\\", "/")}/version-new456/content`),
    });

    const helper = await resolveStudioMcpHelper("win32", environment, probe);
    expect(helper.source).toBe("registry");
    expect(helper.command).toEqual([exe]);
  });

  it("scans Roblox\\Versions for the newest StudioMCP.exe when the registry has nothing", async () => {
    const older = `${VERSIONS}\\version-older\\StudioMCP.exe`;
    const newer = `${VERSIONS}\\version-newer\\StudioMCP.exe`;
    const probe = fakeProbe({
      files: {
        [BAT]: studioBat("version-gone"),
        [`${VERSIONS}\\version-empty\\RobloxStudioBeta.exe`]: "",
        [`${VERSIONS}\\not-a-version\\StudioMCP.exe`]: "",
      },
      exes: { [older]: 100, [newer]: 200 },
      registry: null,
    });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toEqual({
      command: [newer],
      installPath: newer,
      source: "versions_scan",
    });
  });

  it("skips a registry ContentFolder whose StudioMCP.exe is missing", async () => {
    const exe = `${VERSIONS}\\version-real\\StudioMCP.exe`;
    const probe = fakeProbe({
      exes: { [exe]: 1 },
      registry: registryOutput(`${VERSIONS}\\version-gone\\content`),
    });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toMatchObject({
      source: "versions_scan",
    });
  });

  it("finds StudioMCP.exe in the newer Roblox Studio install folder (#117)", async () => {
    const exe = `${LOCAL}\\Roblox Studio\\StudioMCP.exe`;
    const probe = fakeProbe({
      files: { [BAT]: studioBat("version-gone") },
      exes: { [exe]: 1 },
      registry: registryOutput(`${VERSIONS}\\version-gone\\content`),
    });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toEqual({
      command: [exe],
      installPath: exe,
      source: "studio_folder",
    });
  });

  it("prefers a Roblox\\Versions StudioMCP.exe over the Roblox Studio folder", async () => {
    const versioned = `${VERSIONS}\\version-abc\\StudioMCP.exe`;
    const probe = fakeProbe({
      exes: { [versioned]: 1, [`${LOCAL}\\Roblox Studio\\StudioMCP.exe`]: 2 },
    });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toMatchObject({
      source: "versions_scan",
      installPath: versioned,
    });
  });

  it("falls back to mcp.bat through cmd.exe when no StudioMCP.exe is found", async () => {
    const probe = fakeProbe({ files: { [BAT]: "@echo off\r\nsome-other-launcher.exe %*\r\n" } });

    await expect(resolveStudioMcpHelper("win32", environment, probe)).resolves.toEqual({
      command: ["C:\\WINDOWS\\system32\\cmd.exe", "/c", BAT],
      installPath: BAT,
      source: "bat_fallback",
    });
  });

  it("points the fallback at the missing mcp.bat so Studio reads as not installed", async () => {
    const helper = await resolveStudioMcpHelper("win32", environment, fakeProbe({}));

    expect(helper.source).toBe("bat_fallback");
    expect(helper.installPath).toBe(BAT);
  });

  it("keeps the direct StudioMCP binary on macOS without probing", async () => {
    const probe = fakeProbe({});

    await expect(resolveStudioMcpHelper("darwin", {}, probe)).resolves.toEqual({
      command: ["/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"],
      installPath: "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP",
      source: null,
    });
    expect(probe.readText).not.toHaveBeenCalled();
    expect(probe.queryContentFolder).not.toHaveBeenCalled();
  });
});

describe("Studio MCP helper parsing", () => {
  it("reads the path from mcp.bat's first if exist line", () => {
    expect(parseStudioMcpBatPath(studioBat("version-abc"))).toBe(
      `${VERSIONS}\\version-abc\\StudioMCP.exe`,
    );
    expect(parseStudioMcpBatPath("@echo off\r\n")).toBeNull();
  });

  it("reads ContentFolder from reg query output", () => {
    expect(parseContentFolder(registryOutput("C:\\Program Files\\Roblox\\content"))).toBe(
      "C:\\Program Files\\Roblox\\content",
    );
    expect(
      parseContentFolder("\r\n    ContentFolder    REG_EXPAND_SZ    D:\\Roblox\\content   \r\n"),
    ).toBe("D:\\Roblox\\content");
    expect(
      parseContentFolder(
        "ERROR: The system was unable to find the specified registry key or value.",
      ),
    ).toBeNull();
  });
});
