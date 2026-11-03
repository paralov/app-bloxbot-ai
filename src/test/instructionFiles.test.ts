import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findInstructionFiles } from "../../electron/instructionFiles";

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
