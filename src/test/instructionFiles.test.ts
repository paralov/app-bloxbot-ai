import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  findInstructionFiles,
  readInstructions,
  saveInstructions,
} from "../../electron/instructionFiles";

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("instruction files", () => {
  it("reads only BloxBot's own file, never another tool's in the home folder", async () => {
    root = await mkdtemp(join(tmpdir(), "bloxbot-instructions-"));
    const globalConfigDirectory = join(root, "BloxBot", ".opencode", "config", "opencode");
    await mkdir(globalConfigDirectory, { recursive: true });
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, ".claude", "CLAUDE.md"), "Private");
    await writeFile(join(root, "AGENTS.md"), "Private");

    const options = { globalConfigDirectory, home: root };
    await expect(findInstructionFiles(options)).resolves.toEqual([]);

    await writeFile(join(globalConfigDirectory, "AGENTS.md"), "Use tabs");
    await expect(findInstructionFiles(options)).resolves.toEqual([
      {
        path: "~/BloxBot/.opencode/config/opencode/AGENTS.md",
        scope: "global",
        chars: 8,
        content: "Use tabs",
      },
    ]);
  });
});

describe("saved instructions", () => {
  it("says when the file can't be read, rather than showing it as empty", async () => {
    root = await mkdtemp(join(tmpdir(), "bloxbot-instructions-"));
    // A folder where the file should be fails to read with something other than "not found".
    await mkdir(join(root, "AGENTS.md"));
    await expect(readInstructions(root)).rejects.toThrow();
  });

  it("creates the folder, reads back what was saved, and removes the file when emptied", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloxbot-instructions-"));
    const folder = join(root, "config", "opencode");

    await expect(readInstructions(folder)).resolves.toBe("");
    await saveInstructions(folder, "Name folders clearly.");
    await expect(readInstructions(folder)).resolves.toBe("Name folders clearly.");

    await saveInstructions(folder, "   ");
    await expect(readInstructions(folder)).resolves.toBe("");
    await expect(
      findInstructionFiles({ globalConfigDirectory: folder, home: root }),
    ).resolves.toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
