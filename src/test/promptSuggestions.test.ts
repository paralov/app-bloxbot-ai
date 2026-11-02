import { describe, expect, it } from "vitest";
import type { ExplorerNode } from "@/lib/explorer";
import type { Command } from "@/lib/opencode/types";
import {
  buildObjectSearchIndex,
  mergeCommands,
  parseSlashCommand,
  promptTriggerMatch,
  searchCommands,
  searchObjects,
} from "@/lib/promptSuggestions";

function node(name: string, path: string, children: ExplorerNode[] = []): ExplorerNode {
  return {
    name,
    path,
    className: "Part",
    hasChildren: children.length > 0,
    children,
  } as ExplorerNode;
}

describe("promptTriggerMatch", () => {
  const object = promptTriggerMatch("@");
  const command = promptTriggerMatch("/");

  it("opens on a bare trigger, at the start or after a space", () => {
    expect(object("@")?.matchingString).toBe("");
    expect(object("look at @")?.leadOffset).toBe(8);
    expect(command("/")?.matchingString).toBe("");
  });

  it("stays open through the punctuation instance names use", () => {
    expect(object("@my_part")?.matchingString).toBe("my_part");
    expect(object("@Workspace.Part-1")?.matchingString).toBe("Workspace.Part-1");
  });

  it("stays closed mid-word, after a space and on paths", () => {
    expect(object("me@example.com")).toBeNull();
    expect(object("@part ")).toBeNull();
    expect(command("src/app")).toBeNull();
    expect(command("/usr/bin")).toBeNull();
    expect(command("run /goal")).toBeNull();
  });
});

describe("searching", () => {
  it("ranks name matches over path matches, and finds nested objects", () => {
    const index = buildObjectSearchIndex([
      node("Lobby", "game.Workspace.Lobby", [node("Door", "game.Workspace.Lobby.Door")]),
      node("LobbyMusic", "game.SoundService.LobbyMusic"),
      node("MyLobby", "game.Workspace.MyLobby"),
    ]);
    expect(searchObjects(index, "lobby").map((found) => found.name)).toEqual([
      "Lobby",
      "LobbyMusic",
      "MyLobby",
      "Door",
    ]);
  });

  it("lists everything for an empty query, up to the limit", () => {
    const index = buildObjectSearchIndex(
      Array.from({ length: 20 }, (_, i) => node(`Part${i}`, `game.Part${i}`)),
    );
    expect(searchObjects(index, "")).toHaveLength(12);
  });

  it("ranks commands by name before description", () => {
    const commands = [
      { name: "review", description: "Check the init output", hints: [] },
      { name: "init", description: "Set up the project", hints: [] },
    ] as unknown as Command[];
    expect(searchCommands(commands, "init").map((found) => found.name)).toEqual(["init", "review"]);
  });
});

describe("commands", () => {
  it("parses a command and its argument like the desktop app", () => {
    expect(parseSlashCommand("/goal Build a lobby")).toEqual({
      name: "goal",
      input: "Build a lobby",
    });
    expect(parseSlashCommand("  /review\n")).toEqual({ name: "review", input: "" });
    expect(parseSlashCommand("run /goal")).toBeNull();
  });

  it("offers OpenCode's catalog beside the app's own commands", () => {
    const catalog = [{ name: "goal", description: "keep working", template: "", hints: [] }];
    const names = mergeCommands(catalog).map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining(["goal", "new", "undo", "redo", "compact", "fork"]),
    );
  });
});
