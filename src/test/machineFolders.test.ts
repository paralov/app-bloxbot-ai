import { describe, expect, it } from "vitest";
import {
  blenderToolsFolder,
  engineFolder,
  type MachineFolderFileSystem,
} from "../../electron/machineFolders";

const USER_DATA = "C:\\Users\\Ada\\AppData\\Roaming\\bloxbot";
const LOCAL = "C:\\Users\\Ada\\AppData\\Local";
const windows = { platform: "win32" as const, userData: USER_DATA, localAppData: LOCAL };

function fakeFileSystem(present: string[], renameError?: Error) {
  const paths = new Set(present);
  const renames: Array<[string, string]> = [];
  const fileSystem: MachineFolderFileSystem = {
    exists: (path) => paths.has(path),
    mkdir: () => undefined,
    rename: (from, to) => {
      if (renameError) throw renameError;
      renames.push([from, to]);
      paths.delete(from);
      paths.add(to);
    },
  };
  return { fileSystem, renames };
}

describe("engineFolder", () => {
  it("uses this computer's folder on Windows", () => {
    const { fileSystem, renames } = fakeFileSystem([]);
    expect(engineFolder(windows, fileSystem)).toBe(`${LOCAL}\\bloxbot\\opencode`);
    expect(renames).toEqual([]);
  });

  it("moves an engine an earlier version downloaded, so it isn't downloaded again", () => {
    const { fileSystem, renames } = fakeFileSystem([`${USER_DATA}\\opencode`]);
    expect(engineFolder(windows, fileSystem)).toBe(`${LOCAL}\\bloxbot\\opencode`);
    expect(renames).toEqual([[`${USER_DATA}\\opencode`, `${LOCAL}\\bloxbot\\opencode`]]);
  });

  it("keeps using the old folder when it can't be moved", () => {
    const busy = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const { fileSystem } = fakeFileSystem([`${USER_DATA}\\opencode`], busy);
    expect(engineFolder(windows, fileSystem)).toBe(`${USER_DATA}\\opencode`);
  });

  it("leaves the old folder alone once the new one exists", () => {
    const { fileSystem, renames } = fakeFileSystem([
      `${USER_DATA}\\opencode`,
      `${LOCAL}\\bloxbot\\opencode`,
    ]);
    expect(engineFolder(windows, fileSystem)).toBe(`${LOCAL}\\bloxbot\\opencode`);
    expect(renames).toEqual([]);
  });

  it("stays in userData off Windows, or without LOCALAPPDATA", () => {
    const { fileSystem } = fakeFileSystem([]);
    const mac = {
      platform: "darwin" as const,
      userData: "/Users/ada/Library/bloxbot",
      localAppData: undefined,
    };
    expect(engineFolder(mac, fileSystem)).toBe("/Users/ada/Library/bloxbot/opencode");
    expect(engineFolder({ ...windows, localAppData: undefined }, fileSystem)).toMatch(/opencode$/);
    expect(engineFolder({ ...windows, localAppData: undefined }, fileSystem)).not.toContain(LOCAL);
  });
});

describe("blenderToolsFolder", () => {
  it("puts a new setup in this computer's folder on Windows", () => {
    const { fileSystem } = fakeFileSystem([]);
    expect(blenderToolsFolder(windows, fileSystem)).toBe(`${LOCAL}\\bloxbot\\blender-tools`);
  });

  it("keeps a setup that's already there, since its Python environment can't move", () => {
    const { fileSystem, renames } = fakeFileSystem([`${USER_DATA}\\blender-tools`]);
    expect(blenderToolsFolder(windows, fileSystem)).toBe(`${USER_DATA}\\blender-tools`);
    expect(renames).toEqual([]);
  });
});
