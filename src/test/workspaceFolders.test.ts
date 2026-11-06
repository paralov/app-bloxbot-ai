import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureFolder, workspaceFailureReason } from "../../electron/workspaceFolders";

describe("creating BloxBot's folders", () => {
  let workspace = "";
  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });
  const now = () => new Date("2026-11-06T10:00:00.000Z");

  it("creates a missing folder and its parents", async () => {
    workspace = await mkdtemp(join(tmpdir(), "bloxbot-folders-"));
    const state = join(workspace, ".opencode", "state");

    expect(await ensureFolder(workspace, state)).toBeNull();
    expect((await stat(state)).isDirectory()).toBe(true);
  });

  it("moves a file where .opencode should be aside, keeping what it held", async () => {
    workspace = await mkdtemp(join(tmpdir(), "bloxbot-folders-"));
    await writeFile(join(workspace, ".opencode"), "stray");
    const state = join(workspace, ".opencode", "state");

    const movedTo = await ensureFolder(workspace, state, undefined, now);

    expect(movedTo).toBe(join(workspace, ".opencode.bak-2026-11-06T10-00-00-000Z"));
    expect((await stat(state)).isDirectory()).toBe(true);
    expect(await readFile(movedTo ?? "", "utf8")).toBe("stray");
  });

  it("keeps an earlier backup with the same name", async () => {
    workspace = await mkdtemp(join(tmpdir(), "bloxbot-folders-"));
    await writeFile(join(workspace, ".opencode"), "second");
    await writeFile(join(workspace, ".opencode.bak-2026-11-06T10-00-00-000Z"), "first");

    const movedTo = await ensureFolder(workspace, join(workspace, ".opencode"), undefined, now);

    expect(movedTo).toBe(join(workspace, ".opencode.bak-2026-11-06T10-00-00-000Z-1"));
    expect(await readFile(movedTo ?? "", "utf8")).toBe("second");
    expect(await readFile(join(workspace, ".opencode.bak-2026-11-06T10-00-00-000Z"), "utf8")).toBe(
      "first",
    );
  });

  it("moves a file where the folder itself should be aside", async () => {
    workspace = await mkdtemp(join(tmpdir(), "bloxbot-folders-"));
    await mkdir(join(workspace, ".opencode"));
    await writeFile(join(workspace, ".opencode", "state"), "stray");

    await ensureFolder(workspace, join(workspace, ".opencode", "state"), undefined, now);

    expect((await stat(join(workspace, ".opencode", "state"))).isDirectory()).toBe(true);
    expect(await readdir(join(workspace, ".opencode"))).toContain(
      "state.bak-2026-11-06T10-00-00-000Z",
    );
  });

  it("never moves anything above the workspace", async () => {
    workspace = await mkdtemp(join(tmpdir(), "bloxbot-folders-"));
    await writeFile(join(workspace, "home-file"), "keep");

    await expect(
      ensureFolder(
        join(workspace, "home-file", "BloxBot"),
        join(workspace, "home-file", "BloxBot"),
      ),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readFile(join(workspace, "home-file"), "utf8")).toBe("keep");
  });

  it("names the failures someone can act on", () => {
    const failure = (code: string) => Object.assign(new Error(code), { code });
    expect(workspaceFailureReason(failure("ENOSPC"))).toBe("disk_full");
    expect(workspaceFailureReason(failure("EPERM"))).toBe("folder_blocked");
    expect(workspaceFailureReason(failure("EACCES"))).toBe("folder_blocked");
    expect(workspaceFailureReason(failure("EIO"))).toBeNull();
  });
});
