import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOXBOT_PROGRAM_NAMES,
  type BloxBotProgramManifest,
  type BloxBotProgramName,
  buildBloxBotProgramManifest,
  isBloxBotProgramToolAllowed,
  serializeBloxBotProgramManifest,
  usableBloxBotPrograms,
} from "@/lib/bloxbotProgramManifest";
import { signBloxBotProgramManifest } from "../../electron/bloxbotProgramSignature";
import { createBloxBotProgramStore } from "../../electron/services/BloxBotProgramStore";
import { expectedManifest, validated } from "../../scripts/bloxbot-programs/manifestFiles";

const getBloxBotPrograms = vi.hoisted(() => vi.fn());
vi.mock("@/lib/desktop", () => ({ desktop: { getBloxBotPrograms } }));

const ROOT = resolve(__dirname, "../..");

function sources(body = "async function run() { return {}; }") {
  return {
    lib: "function helper() {}",
    programs: Object.fromEntries(BLOXBOT_PROGRAM_NAMES.map((name) => [name, body])) as Record<
      BloxBotProgramName,
      string
    >,
  };
}

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("studio program manifest", () => {
  it("prepends the shared helpers and pins each program's contract", () => {
    const manifest = buildBloxBotProgramManifest(sources(), 3);

    expect(manifest.sequence).toBe(3);
    expect(manifest.programs["explorer-snapshot"]?.source).toBe(
      "function helper() {}\n\nasync function run() { return {}; }\n",
    );
    expect(manifest.programs["explorer-snapshot"]?.contract.outputSchemaVersion).toBe(
      "explorer-snapshot-v1",
    );
  });

  it("refuses to build a manifest the app would reject once the helpers are prepended", () => {
    // Under the 100,000-character envelope limit alone, over it with the helpers.
    const nearLimit = `async function run() { return "${"x".repeat(99_950)}"; }`;

    expect(() => validated(buildBloxBotProgramManifest(sources(nearLimit), 1))).toThrow(
      "would be rejected by the app",
    );
  });

  it("only uses published programs whose contract this app understands", () => {
    const manifest = buildBloxBotProgramManifest(sources(), 2);
    const discovery = manifest.programs["studio-target-discovery"];
    if (!discovery) throw new Error("missing discovery");
    manifest.programs["studio-target-discovery"] = {
      ...discovery,
      contract: { ...discovery.contract, version: "2" },
    };

    const usable = usableBloxBotPrograms(manifest);

    expect(Object.keys(usable).sort()).toEqual(["explorer-snapshot", "studio-target-selection"]);
  });

  it("lets programs use their known tools and any tool Studio marks read-only", () => {
    // Annotations as Roblox Studio's MCP reports them (2026-09-28).
    const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    expect(isBloxBotProgramToolAllowed("explorer-snapshot", "search_game_tree")).toBe(true);
    expect(isBloxBotProgramToolAllowed("explorer-snapshot", "renamed_tree_tool", readOnly)).toBe(
      true,
    );
    expect(
      isBloxBotProgramToolAllowed("explorer-snapshot", "execute_luau", {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      }),
    ).toBe(false);
    expect(
      isBloxBotProgramToolAllowed("explorer-snapshot", "http_get", {
        ...readOnly,
        openWorldHint: true,
      }),
    ).toBe(false);
    expect(isBloxBotProgramToolAllowed("explorer-snapshot", "unlabelled_tool")).toBe(false);
    // MCP treats a missing openWorldHint as open-world, so it doesn't count as read-only.
    expect(
      isBloxBotProgramToolAllowed("explorer-snapshot", "maybe_network", { readOnlyHint: true }),
    ).toBe(false);
    expect(isBloxBotProgramToolAllowed("something-else", "list_roblox_studios", readOnly)).toBe(
      false,
    );
  });

  it("ships a manifest.json that matches bloxbot-programs/ (run `pnpm bloxbot-programs build`)", async () => {
    // The same check as `pnpm bloxbot-programs check`, including the sequence bump.
    expect(serializeBloxBotProgramManifest(await expectedManifest())).toBe(
      await readFile(join(ROOT, "bloxbot-programs", "manifest.json"), "utf8"),
    );
  });
});

describe("studio program store", () => {
  const { publicKey, privateKey } = keys();

  function published(manifest: BloxBotProgramManifest, signWith = privateKey) {
    const raw = serializeBloxBotProgramManifest(manifest);
    const signature = signBloxBotProgramManifest(raw, signWith);
    return vi.fn(
      async (url: string) => new Response(url.endsWith(".sig") ? signature : raw, { status: 200 }),
    ) as unknown as typeof fetch;
  }

  async function store(fetchImpl: typeof fetch, directory?: string) {
    const dir = directory ?? (await mkdtemp(join(tmpdir(), "bloxbot-programs-")));
    return {
      dir,
      store: createBloxBotProgramStore({ directory: dir, fetch: fetchImpl, publicKey }),
    };
  }

  it("keeps a validly signed manifest and reloads it from the cache", async () => {
    const manifest = buildBloxBotProgramManifest(sources(), 5);
    const first = await store(published(manifest));

    expect(await first.store.refresh()).toBe("updated");
    expect(first.store.current()?.sequence).toBe(5);

    const reloaded = await store(published(manifest), first.dir);
    await reloaded.store.load();
    expect(reloaded.store.current()?.sequence).toBe(5);
  });

  it("rejects a manifest signed with any other key", async () => {
    const other = keys();
    const { store: rejecting } = await store(
      published(buildBloxBotProgramManifest(sources(), 5), other.privateKey),
    );

    expect(await rejecting.refresh()).toBe("rejected");
    expect(rejecting.current()).toBeNull();
  });

  it("never goes back to an older sequence, even when it is signed", async () => {
    const { dir, store: newer } = await store(published(buildBloxBotProgramManifest(sources(), 7)));
    await newer.refresh();

    const { store: older } = await store(
      published(buildBloxBotProgramManifest(sources("async function run() { return 1; }"), 6)),
      dir,
    );
    await older.load();

    expect(await older.refresh()).toBe("rejected");
    expect(older.current()?.sequence).toBe(7);
  });

  it("ignores a cached manifest that was changed on disk", async () => {
    const { dir, store: first } = await store(published(buildBloxBotProgramManifest(sources(), 4)));
    await first.refresh();
    const path = join(dir, "cache.json");
    await writeFile(path, (await readFile(path, "utf8")).replace("return {}", "return evil()"));

    const { store: reloaded } = await store(
      published(buildBloxBotProgramManifest(sources(), 4)),
      dir,
    );
    await reloaded.load();

    expect(reloaded.current()).toBeNull();
  });

  it("reports a failed cache write instead of throwing", async () => {
    const blocked = join(await mkdtemp(join(tmpdir(), "bloxbot-programs-")), "file");
    await writeFile(blocked, "not a directory");
    const { store: unwritable } = await store(
      published(buildBloxBotProgramManifest(sources(), 5)),
      join(blocked, "cache"),
    );

    await expect(unwritable.refresh()).resolves.toBe("unavailable");
    expect(unwritable.current()).toBeNull();
  });

  it("stays on what it has when the download fails", async () => {
    const failing = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const { store: offline } = await store(failing);

    expect(await offline.refresh()).toBe("unavailable");
    expect(offline.current()).toBeNull();
  });
});

describe("resolveBloxBotPrograms", () => {
  beforeEach(() => {
    vi.resetModules();
    getBloxBotPrograms.mockReset();
  });

  async function resolve() {
    const { resolveBloxBotPrograms } = await import("@/lib/bloxbotPrograms");
    const { BUILTIN_BLOXBOT_PROGRAM_MANIFEST } = await import("@/lib/builtinBloxBotPrograms");
    return { resolved: await resolveBloxBotPrograms(), builtin: BUILTIN_BLOXBOT_PROGRAM_MANIFEST };
  }

  it("uses published programs that are newer than the built-in ones", async () => {
    const { BUILTIN_BLOXBOT_PROGRAM_MANIFEST } = await import("@/lib/builtinBloxBotPrograms");
    const newer = buildBloxBotProgramManifest(
      sources("async function run() { return { roots: [] }; }"),
      BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence + 1,
    );
    getBloxBotPrograms.mockResolvedValue(newer);

    const { resolved } = await resolve();

    expect(resolved.explorer.source).toBe("published");
    expect(resolved.explorer.program.source).toBe(newer.programs["explorer-snapshot"]?.source);
    expect(resolved.targets.source).toBe("published");
  });

  it("keeps the built-in programs when the published copy isn't newer or can't be read", async () => {
    const { BUILTIN_BLOXBOT_PROGRAM_MANIFEST } = await import("@/lib/builtinBloxBotPrograms");
    getBloxBotPrograms.mockResolvedValue(
      buildBloxBotProgramManifest(sources(), BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence),
    );
    expect((await resolve()).resolved.explorer.source).toBe("builtin");

    getBloxBotPrograms.mockRejectedValue(new Error("bridge unavailable"));
    expect((await resolve()).resolved.explorer.source).toBe("builtin");
  });

  it("falls back to the built-in program when a published one doesn't fit the app's schema", async () => {
    const { BUILTIN_BLOXBOT_PROGRAM_MANIFEST } = await import("@/lib/builtinBloxBotPrograms");
    const newer = buildBloxBotProgramManifest(
      sources(),
      BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence + 1,
    );
    const explorer = newer.programs["explorer-snapshot"];
    if (!explorer) throw new Error("missing explorer");
    newer.programs["explorer-snapshot"] = { ...explorer, source: "x".repeat(100_001) };
    getBloxBotPrograms.mockResolvedValue(newer);

    const { resolved } = await resolve();

    expect(resolved.explorer.source).toBe("builtin");
    expect(resolved.targets.source).toBe("published");
  });

  it("records each program's own origin when only some published programs are usable", async () => {
    const { BUILTIN_BLOXBOT_PROGRAM_MANIFEST } = await import("@/lib/builtinBloxBotPrograms");
    const newer = buildBloxBotProgramManifest(
      sources(),
      BUILTIN_BLOXBOT_PROGRAM_MANIFEST.sequence + 1,
    );
    const explorer = newer.programs["explorer-snapshot"];
    if (!explorer) throw new Error("missing explorer");
    newer.programs["explorer-snapshot"] = {
      ...explorer,
      contract: { ...explorer.contract, version: "2" },
    };
    getBloxBotPrograms.mockResolvedValue(newer);

    const { resolved } = await resolve();

    expect(resolved.explorer.source).toBe("builtin");
    expect(resolved.targets.source).toBe("published");
  });
});
