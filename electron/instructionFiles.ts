import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { InstructionFile } from "../src/types/desktop";

const MAX_INSTRUCTION_LENGTH = 32_000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Home-relative, forward-slash paths so analytics rows match across platforms. */
function displayPath(path: string, home: string): string {
  const relative =
    path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
  return sep === "\\" ? relative.replaceAll("\\", "/") : relative;
}

/**
 * The instruction file OpenCode loads for BloxBot. It runs with project config off, so this is the
 * only one, and nothing outside BloxBot's folder is read.
 */
export async function findInstructionFiles(options: {
  globalConfigDirectory: string;
  home: string;
}): Promise<InstructionFile[]> {
  const path = join(options.globalConfigDirectory, "AGENTS.md");
  const found = (await exists(path)) ? [{ path, scope: "global" as const }] : [];

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

/** What the user wrote in Settings, which is the file OpenCode loads. */
export async function readInstructions(globalConfigDirectory: string): Promise<string> {
  return readFile(join(globalConfigDirectory, "AGENTS.md"), "utf8").catch(() => "");
}

export async function saveInstructions(globalConfigDirectory: string, text: string): Promise<void> {
  const path = join(globalConfigDirectory, "AGENTS.md");
  if (!text.trim()) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(globalConfigDirectory, { recursive: true });
  await writeFile(path, text);
}
