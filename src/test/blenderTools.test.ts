import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLENDER_MCP_PORT,
  blenderMcpServerConfig,
  downloadPinned,
  getBlenderToolsState,
  installBlenderTools,
  isBlenderInstalled,
  openBlender,
  removeBlenderTools,
} from "../../electron/services/BlenderTools";

const CONTENTS = Buffer.from("blender bytes, all of them");
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const FILE = {
  name: "file.bin",
  url: "https://example.test/file.bin",
  sha256: sha256(CONTENTS),
  bytes: CONTENTS.length,
};

describe("Blender tools", () => {
  const made: string[] = [];
  const directory = async () => {
    const path = await mkdtemp(join(tmpdir(), "bloxbot-blender-"));
    made.push(path);
    return path;
  };
  afterEach(async () => {
    await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  describe("downloading", () => {
    it("saves a file that matches, and doesn't fetch it again", async () => {
      const root = await directory();
      const fetch = vi.fn(async () => new Response(CONTENTS));

      const path = await downloadPinned(FILE, root, { fetch });
      await downloadPinned(FILE, root, { fetch });

      expect(await readFile(path)).toEqual(CONTENTS);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("carries on from what's saved", async () => {
      const root = await directory();
      await writeFile(join(root, "file.bin.partial"), CONTENTS.subarray(0, 6));
      const fetch = vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(CONTENTS.subarray(6), {
            status: (init?.headers as Record<string, string>).Range === "bytes=6-" ? 206 : 200,
          }),
      );

      const path = await downloadPinned(FILE, root, { fetch });

      expect(await readFile(path)).toEqual(CONTENTS);
    });

    it("starts over when the server sends the whole file instead", async () => {
      const root = await directory();
      await writeFile(join(root, "file.bin.partial"), CONTENTS.subarray(0, 6));
      const path = await downloadPinned(FILE, root, {
        fetch: async () => new Response(CONTENTS),
      });

      expect(await readFile(path)).toEqual(CONTENTS);
    });

    it("refuses and removes a file that doesn't match", async () => {
      const root = await directory();
      const wrong = Buffer.alloc(CONTENTS.length, 1);

      await expect(
        downloadPinned(FILE, root, { fetch: async () => new Response(wrong) }),
      ).rejects.toMatchObject({ reason: "corrupt" });

      expect(await readdir(root)).toEqual([]);
    });

    it("keeps trying while data is still arriving", async () => {
      const root = await directory();
      let calls = 0;
      const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        calls += 1;
        // Each attempt delivers one byte, then the connection drops.
        const from = Number(
          (init?.headers as Record<string, string>).Range?.match(/\d+/)?.[0] ?? 0,
        );
        let sent = false;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (sent) {
                // Long enough for what arrived to reach the disk, as it would on a real connection.
                await new Promise((resolve) => setTimeout(resolve, 10));
                controller.error(new TypeError("dropped"));
                return;
              }
              sent = true;
              controller.enqueue(CONTENTS.subarray(from, from + 1));
              if (from + 1 >= CONTENTS.length) controller.close();
            },
          }),
          { status: from > 0 ? 206 : 200 },
        );
      });

      const path = await downloadPinned(FILE, root, { fetch, retryDelaysMs: [0] });

      expect(await readFile(path)).toEqual(CONTENTS);
      expect(calls).toBeGreaterThan(CONTENTS.length - 1);
    });

    it("gives up on a connection that's gone, and keeps what it has", async () => {
      const root = await directory();
      await writeFile(join(root, "file.bin.partial"), CONTENTS.subarray(0, 6));

      await expect(
        downloadPinned(FILE, root, {
          fetch: async () => {
            throw new TypeError("offline");
          },
          retryDelaysMs: [0],
        }),
      ).rejects.toMatchObject({ reason: "network" });

      expect((await stat(join(root, "file.bin.partial"))).size).toBe(6);
    });

    it("says when a server refuses, rather than retrying", async () => {
      const root = await directory();
      const fetch = vi.fn(async () => new Response("no", { status: 403 }));

      await expect(downloadPinned(FILE, root, { fetch })).rejects.toMatchObject({
        reason: "network",
      });
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("stops when asked", async () => {
      const root = await directory();
      const stop = new AbortController();
      stop.abort();

      await expect(
        downloadPinned(FILE, root, { fetch: vi.fn(), signal: stop.signal }),
      ).rejects.toThrow();
    });
  });

  describe("state", () => {
    it("doesn't offer it where Blender has no build", async () => {
      await expect(getBlenderToolsState(await directory(), "darwin", "x64")).resolves.toEqual({
        state: "unsupported",
      });
    });

    it("isn't ready until setup has finished", async () => {
      await expect(getBlenderToolsState(await directory(), "darwin", "arm64")).resolves.toEqual({
        state: "not_installed",
      });
    });
  });

  describe("setup", () => {
    const blenderApp = (root: string) =>
      join(root, "blender-5.2.3", "Blender.app", "Contents", "MacOS", "Blender");
    const serverApp = (root: string) =>
      join(root, "mcp-server-1.0.3", ".venv", "bin", "blender-mcp");
    const touch = async (path: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "");
    };
    const install = (root: string, overrides = {}) =>
      Effect.runPromise(
        Effect.either(
          installBlenderTools({
            root,
            platform: "darwin",
            arch: "arm64",
            fetch: vi.fn(),
            freeBytes: async () => 10 * 1024 ** 3,
            download: async (file, directory) => join(directory, file.name),
            unpack: {
              blender: () => touch(blenderApp(root)),
              uv: async () => "/uv",
              server: () => touch(serverApp(root)),
            },
            runCommand: async () => {},
            ...overrides,
          }),
        ),
      );
    /** Stands in for a server that's down. */
    const refused = () => vi.fn(async () => new Response("no", { status: 500 }));

    it("runs each step, and only then says it's ready", async () => {
      const root = await directory();
      const commands: string[] = [];
      const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
        commands.push(`${command} ${args.join(" ")}`);
        await expect(isBlenderInstalled(root)).resolves.toBe(false);
      });
      const progress: string[] = [];

      const result = await install(root, {
        runCommand,
        onProgress: ({ step }: { step: string }) => {
          if (progress.at(-1) !== step) progress.push(step);
        },
      });

      expect(Either.isRight(result)).toBe(true);
      expect(progress).toEqual(["unpacking", "connecting"]);
      expect(commands).toHaveLength(3);
      expect(commands[0]).toContain("/uv sync --frozen");
      expect(commands[1]).toContain("extension install-file -r user_default -e");
      expect(commands[2]).toContain(`preferences.port = ${BLENDER_MCP_PORT}`);
      await expect(isBlenderInstalled(root, "darwin")).resolves.toBe(true);
      // Python's dependencies come from the lock shipped with BloxBot, not whatever's newest.
      const server = join(root, "mcp-server-1.0.3");
      expect(await readFile(join(server, "uv.lock"), "utf8")).toContain('name = "mcp"');
      await expect(stat(join(root, "downloads"))).rejects.toThrow();
    });

    it("stops every other download when one fails, before it says so", async () => {
      const root = await directory();
      const stopped: string[] = [];
      let finished = false;
      const result = install(root, {
        download: async (
          file: { name: string },
          _dir: string,
          options: { signal: AbortSignal },
        ) => {
          if (file.name.startsWith("uv-")) throw new Error("network");
          await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
          // Still busy for a moment after being told, like a real download closing its file.
          await new Promise((resolve) => setTimeout(resolve, 20));
          stopped.push(file.name);
          finished = true;
          throw new Error("stopped");
        },
      }).then((value) => {
        expect(finished).toBe(true);
        return value;
      });

      const outcome = await result;
      expect(Either.isLeft(outcome)).toBe(true);
      expect(stopped).toHaveLength(3);
      expect(String(Either.isLeft(outcome) ? outcome.left.message : "")).not.toContain("stopped");
    });

    it("treats a marker cut short as not installed, so it can't stop OpenCode starting", async () => {
      const root = await directory();
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "installed.json"), '{"blender":');
      await expect(isBlenderInstalled(root)).resolves.toBe(false);
    });

    it("stops partway through connecting, and doesn't finish", async () => {
      const root = await directory();
      const stop = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const result = await install(root, {
        signal: stop.signal,
        runCommand: async (
          _command: string,
          _args: readonly string[],
          _env: NodeJS.ProcessEnv,
          signal?: AbortSignal,
        ) => {
          seen.push(signal);
          stop.abort();
          throw new Error("killed");
        },
      });

      expect(Either.isLeft(result)).toBe(true);
      expect(seen).toEqual([stop.signal]);
      await expect(isBlenderInstalled(root)).resolves.toBe(false);
    });

    it("stops between unpacking steps, and hands the one running the signal", async () => {
      const root = await directory();
      const stop = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const later = vi.fn(async () => "/uv");
      const runCommand = vi.fn(async () => {});
      const result = await install(root, {
        signal: stop.signal,
        runCommand,
        unpack: {
          blender: async (_archive: string, _destination: string, signal?: AbortSignal) => {
            seen.push(signal);
            await touch(blenderApp(root));
            stop.abort();
          },
          uv: later,
          server: later,
        },
      });

      expect(Either.isLeft(result) && result.left.message).toBe("Setup was stopped");
      expect(seen).toEqual([stop.signal]);
      expect(later).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      await expect(stat(join(root, "installed.json"))).rejects.toThrow();
    });

    it("needs setting up again once Blender or its server has gone", async () => {
      for (const removed of [blenderApp, serverApp]) {
        const root = await directory();
        expect(Either.isRight(await install(root))).toBe(true);
        await expect(isBlenderInstalled(root, "darwin")).resolves.toBe(true);

        await rm(removed(root));

        await expect(isBlenderInstalled(root, "darwin")).resolves.toBe(false);
        await expect(getBlenderToolsState(root, "darwin", "arm64")).resolves.toEqual({
          state: "not_installed",
        });
      }
    });

    it("reports a Blender that won't start, instead of crashing the app", async () => {
      await expect(openBlender(await directory())).rejects.toThrow();
    });

    it("keeps its settings away from someone's own Blender", async () => {
      const root = await directory();
      const environments: NodeJS.ProcessEnv[] = [];

      await install(root, {
        runCommand: async (_command: string, _args: readonly string[], env: NodeJS.ProcessEnv) => {
          environments.push(env);
        },
      });

      expect(environments[0].UV_CACHE_DIR).toBe(join(root, "uv-cache"));
      expect(environments[1].BLENDER_USER_RESOURCES).toBe(join(root, "user"));
      expect(environments[2].BLENDER_USER_RESOURCES).toBe(join(root, "user"));
    });

    it("isn't marked ready when Blender won't take the add-on", async () => {
      const root = await directory();

      const result = await install(root, {
        runCommand: async () => {
          throw new Error("no");
        },
      });

      expect(Either.isLeft(result)).toBe(true);
      await expect(isBlenderInstalled(root)).resolves.toBe(false);
    });

    it("won't start without room for it", async () => {
      const root = await directory();
      const fetch = vi.fn();

      const result = await install(root, { fetch, freeBytes: async () => 1024 });

      expect(Either.isLeft(result) && result.left.reason).toBe("disk_full");
      expect(fetch).not.toHaveBeenCalled();
    });

    it("isn't marked ready when a step fails", async () => {
      const root = await directory();

      const result = await install(root, { fetch: refused(), download: undefined });

      expect(Either.isLeft(result)).toBe(true);
      await expect(isBlenderInstalled(root)).resolves.toBe(false);
    });

    it("removes everything", async () => {
      const root = await directory();
      await writeFile(join(root, "installed.json"), "{}");

      await removeBlenderTools(root);

      await expect(stat(root)).rejects.toThrow();
    });
  });

  it("points OpenCode at the installed server, on BloxBot's own port", () => {
    const config = blenderMcpServerConfig("/tools", "darwin");

    expect(config.type).toBe("local");
    expect(config.command).toEqual([
      join("/tools", "mcp-server-1.0.3", ".venv", "bin", "blender-mcp"),
    ]);
    expect(config.environment.BLENDER_MCP_PORT).toBe(String(BLENDER_MCP_PORT));
    expect(config.environment.BLENDER_USER_RESOURCES).toBe(join("/tools", "user"));
    expect(blenderMcpServerConfig("C:\\tools", "win32").command[0]).toContain("blender-mcp.exe");
  });
});
