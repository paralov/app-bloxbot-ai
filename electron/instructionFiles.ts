import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { InstructionFile } from "../src/types/desktop";

const MAX_INSTRUCTION_LENGTH = 32_000;
const PROJECT_INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Directories from `start` up to the enclosing git root, or the filesystem root. */
async function ancestors(start: string): Promise<string[]> {
  const directories: string[] = [];
  let current = resolve(start);
  while (true) {
    directories.push(current);
    if (await exists(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function displayPath(path: string, home: string): string {
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * Mirrors OpenCode's system instruction lookup: the first global file that exists,
 * plus every ancestor match of the first project file name that exists.
 * Nested instruction files are attached by OpenCode to read tool output instead.
 */
export async function findInstructionFiles(options: {
  workspace: string;
  globalConfigDirectory: string;
  home: string;
}): Promise<InstructionFile[]> {
  const found: Array<{ path: string; scope: InstructionFile["scope"] }> = [];

  for (const path of [
    join(options.globalConfigDirectory, "AGENTS.md"),
    join(options.home, ".claude", "CLAUDE.md"),
  ]) {
    if (await exists(path)) {
      found.push({ path, scope: "global" });
      break;
    }
  }

  const directories = await ancestors(options.workspace);
  for (const name of PROJECT_INSTRUCTION_NAMES) {
    const matches: string[] = [];
    for (const directory of directories) {
      const path = join(directory, name);
      if (await exists(path)) matches.push(path);
    }
    if (matches.length > 0) {
      for (const path of matches) found.push({ path, scope: "project" });
      break;
    }
  }

  const files = await Promise.all(
    found.map(async ({ path, scope }) => {
      const content = await readFile(path, "utf8").catch(() => "");
      return {
        path: displayPath(path, options.home),
        scope,
        chars: content.length,
        content:
          content.length > MAX_INSTRUCTION_LENGTH
            ? `${content.slice(0, MAX_INSTRUCTION_LENGTH)}… [truncated]`
            : content,
      };
    }),
  );
  return files.filter((file) => file.content.length > 0);
}
