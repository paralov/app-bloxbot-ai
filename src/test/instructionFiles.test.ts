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
  it("finds the global file and every project match of the first file name, like OpenCode", async () => {
    root = await mkdtemp(join(tmpdir(), "bloxbot-instructions-"));
    const home = join(root, "home");
    const workspace = join(home, "BloxBot");
    const globalConfigDirectory = join(workspace, ".opencode", "config", "opencode");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(globalConfigDirectory, { recursive: true });
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(globalConfigDirectory, "AGENTS.md"), "global rules");
    await writeFile(join(home, ".claude", "CLAUDE.md"), "skipped: global AGENTS.md wins");
    await writeFile(join(workspace, "AGENTS.md"), "workspace rules");
    await writeFile(join(home, "AGENTS.md"), "home rules");
    await writeFile(join(workspace, "CLAUDE.md"), "skipped: AGENTS.md matched first");

    const files = await findInstructionFiles({ workspace, globalConfigDirectory, home });

    expect(files).toEqual([
      {
        path: "~/BloxBot/.opencode/config/opencode/AGENTS.md",
        scope: "global",
        chars: 12,
        content: "global rules",
      },
      { path: "~/BloxBot/AGENTS.md", scope: "project", chars: 15, content: "workspace rules" },
      { path: "~/AGENTS.md", scope: "project", chars: 10, content: "home rules" },
    ]);
  });
});
