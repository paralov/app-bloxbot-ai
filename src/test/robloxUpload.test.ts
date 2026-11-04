import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Fetcher,
  forgetRobloxKey,
  getRobloxUploadState,
  inspectRobloxKey,
  type KeyEncryption,
  loadRobloxKey,
  MAX_MODEL_BYTES,
  modelDisplayName,
  moderationOf,
  readModelFile,
  readSentModel,
  recordSentModel,
  saveRobloxKey,
  sendModelToPlace,
} from "../../electron/services/RobloxUpload";

const SECRET = "secret-roblox-key-value";
const OWNER = "1739783978";
const encryption: KeyEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`enc:${text}`),
  decryptString: (data) => data.toString().replace(/^enc:/, ""),
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const goodIntrospect = {
  authorizedUserId: OWNER,
  enabled: true,
  expired: false,
  scopes: [{ name: "asset", operations: ["read", "write"], userIds: [OWNER] }],
};

function roblox(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    for (const [part, reply] of Object.entries(overrides)) {
      if (url.includes(part)) return reply(init);
    }
    if (url.includes("/users/")) return json({ name: `name-${url.split("/").at(-1)}` });
    if (url.includes("/introspect")) return json(goodIntrospect);
    if (url.endsWith("/assets/v1/assets")) {
      return json({
        done: true,
        response: { assetId: "555", moderationResult: { moderationState: "Approved" } },
      });
    }
    throw new Error(`Unexpected call: ${url}`);
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

let dir: string;
let modelUrl: string;
let keyFile: string;
let sentFile: string;

const deps = (fetcher: Fetcher, extra: Partial<Parameters<typeof sendModelToPlace>[1]> = {}) => ({
  keyFile,
  sentFile,
  encryption,
  expectedHash: createHash("sha256").update("model bytes").digest("hex"),
  fetcher,
  sleep: async () => {},
  studioAccount: async () => OWNER,
  insert: vi.fn(async () => "game.Workspace.Crate"),
  ...extra,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "roblox-upload-"));
  const model = join(dir, "Crate.fbx");
  await writeFile(model, "model bytes");
  modelUrl = pathToFileURL(model).href;
  keyFile = join(dir, "key.json");
  sentFile = join(dir, "sent.json");
  await saveRobloxKey(keyFile, encryption, SECRET, { ownerId: OWNER, ownerName: "CipherBolt" });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("what a key can do", () => {
  it("accepts a key limited to its owner, and says who that is", async () => {
    const { fetcher } = roblox();
    expect(await inspectRobloxKey(SECRET, fetcher)).toMatchObject({
      result: "checked",
      ownerId: OWNER,
      ownerName: `name-${OWNER}`,
      active: true,
      canUpload: true,
      reachesGroups: false,
      extraAccess: [],
    });
  });

  it("sees a key that isn't restricted by creator, as a real unrestricted key reports it", async () => {
    const { fetcher } = roblox({
      introspect: () =>
        json({
          ...goodIntrospect,
          scopes: [
            { name: "asset", operations: ["read", "write"], userIds: ["*"], groupIds: ["*"] },
          ],
        }),
    });
    expect(await inspectRobloxKey(SECRET, fetcher)).toMatchObject({ reachesGroups: true });
  });

  it("names anything extra, and notices a missing operation", async () => {
    const { fetcher } = roblox({
      introspect: () =>
        json({
          ...goodIntrospect,
          scopes: [
            { name: "asset", operations: ["read"], userIds: [OWNER] },
            { name: "universe-datastores.objects", operations: ["create"] },
          ],
        }),
    });
    expect(await inspectRobloxKey(SECRET, fetcher)).toMatchObject({
      canUpload: false,
      extraAccess: ["universe-datastores.objects"],
    });
  });

  it("tells a bad key from Roblox being unreachable", async () => {
    expect(
      await inspectRobloxKey(SECRET, roblox({ introspect: () => json({}, 401) }).fetcher),
    ).toEqual({ result: "not_a_key" });
    expect(
      await inspectRobloxKey(SECRET, roblox({ introspect: () => json({}, 503) }).fetcher),
    ).toEqual({ result: "unreachable" });
    const down = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as Fetcher;
    expect(await inspectRobloxKey(SECRET, down)).toEqual({ result: "unreachable" });
  });
});

describe("keeping the key", () => {
  it("never writes the key in plain text", async () => {
    expect(await readFile(keyFile, "utf8")).not.toContain(SECRET);
    expect((await loadRobloxKey(keyFile, encryption))?.key).toBe(SECRET);
  });

  it("reports the owner without decrypting, and forgets", async () => {
    const decrypt = vi.spyOn(encryption, "decryptString");
    expect(await getRobloxUploadState(keyFile, encryption)).toEqual({
      state: "on",
      ownerId: OWNER,
      ownerName: "CipherBolt",
    });
    expect(decrypt).not.toHaveBeenCalled();
    await forgetRobloxKey(keyFile);
    expect(await getRobloxUploadState(keyFile, encryption)).toEqual({ state: "off" });
  });

  it("refuses when the computer can't really encrypt", async () => {
    const weak = { ...encryption, getSelectedStorageBackend: () => "basic_text" };
    await forgetRobloxKey(keyFile);
    expect(await getRobloxUploadState(keyFile, weak)).toEqual({ state: "unavailable" });
    await expect(
      saveRobloxKey(keyFile, weak, SECRET, { ownerId: OWNER, ownerName: null }),
    ).rejects.toThrow();
  });
});

describe("reading a model", () => {
  it("reads only local model files within Roblox's limit", async () => {
    expect((await readModelFile(modelUrl))?.name).toBe("Crate");
    const other = join(dir, "notes.txt");
    await writeFile(other, "private");
    expect(await readModelFile(pathToFileURL(other).href)).toBeNull();
    expect(await readModelFile("https://example.com/Crate.fbx")).toBeNull();
    expect(await readModelFile("file://attacker.example/share/Crate.fbx")).toBeNull();
    expect(await readModelFile(pathToFileURL(join(dir, "missing.fbx")).href)).toBeNull();
    const huge = join(dir, "Huge.glb");
    await writeFile(huge, Buffer.alloc(MAX_MODEL_BYTES + 1));
    expect(await readModelFile(pathToFileURL(huge).href)).toBeNull();
  });

  it("makes a name Roblox will take from a file name", () => {
    expect(modelDisplayName("/a/My_Crate (v2)!.fbx")).toBe("My_Crate v2");
    expect(modelDisplayName("/a/!!!.fbx")).toBe("Model");
    expect(modelDisplayName(`/a/${"x".repeat(80)}.fbx`)).toHaveLength(50);
  });
});

describe("moderation", () => {
  it("understands what Roblox really answers and what its docs say", () => {
    const of = (moderationState: string) => moderationOf({ moderationResult: { moderationState } });
    expect(of("Approved")).toBe("approved");
    expect(of("MODERATION_STATE_APPROVED")).toBe("approved");
    expect(of("Rejected")).toBe("rejected");
    expect(of("MODERATION_STATE_REJECTED")).toBe("rejected");
    expect(of("Reviewing")).toBe("checking");
    expect(moderationOf({})).toBe("checking");
  });
});

describe("from the click to the place", () => {
  it("uploads, then adds it to the place", async () => {
    const { fetcher, calls } = roblox();
    const insert = vi.fn(async () => "game.Workspace.Crate");
    const steps: string[] = [];
    const result = await sendModelToPlace(
      modelUrl,
      deps(fetcher, { insert, onStep: (s) => steps.push(s) }),
    );
    expect(result).toEqual({ status: "added", assetId: "555", path: "game.Workspace.Crate" });
    expect(insert).toHaveBeenCalledWith("555", "Crate");
    expect(steps).toEqual(["uploading", "adding"]);
    expect(calls.filter((c) => c.startsWith("POST https://apis.roblox.com/assets"))).toHaveLength(
      1,
    );
  });

  it("sends the key's owner as the creator, and the key only to Roblox", async () => {
    let sentBody = "";
    const seen: string[] = [];
    const { fetcher } = roblox({
      "/assets/v1/assets": (init) => {
        sentBody = String(init?.body);
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(SECRET);
        return json({
          done: true,
          response: { assetId: "555", moderationResult: { moderationState: "Approved" } },
        });
      },
    });
    const spying = (async (input: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.["x-api-key"] === SECRET || String(init?.body).includes(SECRET)) {
        seen.push(new URL(String(input)).hostname);
      }
      return fetcher(input as RequestInfo, init);
    }) as Fetcher;
    await sendModelToPlace(modelUrl, deps(spying));
    const request = JSON.parse(/\r\n\r\n(\{.*\})\r\n--/.exec(sentBody)?.[1] ?? "{}");
    expect(request).toMatchObject({
      assetType: "Model",
      displayName: "Crate",
      creationContext: { creator: { userId: OWNER } },
    });
    expect(new Set(seen)).toEqual(new Set(["apis.roblox.com"]));
  });

  it("sends the same multipart shape that worked against Roblox", async () => {
    let contentType = "";
    let body = "";
    const server = createServer((request, response) => {
      contentType = request.headers["content-type"] ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        body = Buffer.concat(chunks).toString();
        response.end(
          JSON.stringify({
            done: true,
            response: { assetId: "1", moderationResult: { moderationState: "Approved" } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const { fetcher } = roblox({
      "/assets/v1/assets": () => {
        throw new Error("should use the local server");
      },
    });
    const viaServer = (async (input: unknown, init?: RequestInit) =>
      String(input).endsWith("/assets/v1/assets")
        ? fetch(`http://127.0.0.1:${port}/`, init)
        : fetcher(input as RequestInfo, init)) as Fetcher;
    await sendModelToPlace(modelUrl, deps(viaServer));
    server.close();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(body).toContain('name="request"');
    expect(body).toContain('name="fileContent"; filename="Crate.fbx"');
    expect(body).toContain("Content-Type: model/fbx");
    expect(body).toContain("model bytes");
  });

  it("uploads nothing when Studio is on another account, which could never load it", async () => {
    const { fetcher, calls } = roblox();
    const result = await sendModelToPlace(
      modelUrl,
      deps(fetcher, { studioAccount: async () => "9641755376" }),
    );
    expect(result).toEqual({
      status: "wrong_account",
      keyOwner: `name-${OWNER}`,
      studio: "name-9641755376",
    });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
  });

  it("uploads nothing when Studio can't say who's signed in", async () => {
    const { fetcher, calls } = roblox();
    const studioAccount = async () => {
      throw new Error("closed");
    };
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { studioAccount }))).toEqual({
      status: "failed",
      reason: "no_studio",
    });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
  });

  it("uploads nothing with a key that's been switched off, and says so", async () => {
    const { fetcher, calls } = roblox({
      introspect: () => json({ ...goodIntrospect, enabled: false }),
    });
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toEqual({
      status: "failed",
      reason: "key_off",
    });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
  });

  it("never sends the same file twice, and adds it again without uploading", async () => {
    const { fetcher, calls } = roblox();
    await sendModelToPlace(modelUrl, deps(fetcher));
    calls.length = 0;
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toMatchObject({
      status: "added",
      assetId: "555",
    });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
  });

  it("never resends a rejected file, and doesn't add it", async () => {
    const { fetcher, calls } = roblox({
      "/assets/v1/assets": () =>
        json({
          done: true,
          response: { assetId: "9", moderationResult: { moderationState: "Rejected" } },
        }),
    });
    const insert = vi.fn(async () => "x");
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { insert }))).toEqual({
      status: "rejected",
      assetId: "9",
    });
    calls.length = 0;
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { insert }))).toEqual({
      status: "rejected",
      assetId: "9",
    });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it("keeps a model out of the place until Roblox approves it", async () => {
    let approved = false;
    const { fetcher } = roblox({
      "readMask=moderationResult": () =>
        json({ moderationResult: { moderationState: approved ? "Approved" : "Reviewing" } }),
      "/assets/v1/assets": () =>
        json({
          done: true,
          response: { assetId: "7", moderationResult: { moderationState: "Reviewing" } },
        }),
    });
    const insert = vi.fn(async () => "game.Workspace.Crate");
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { insert }))).toEqual({
      status: "checking",
      assetId: "7",
    });
    expect(insert).not.toHaveBeenCalled();
    approved = true;
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { insert }))).toMatchObject({
      status: "added",
      assetId: "7",
    });
    expect(
      (await readSentModel(sentFile, (await readModelFile(modelUrl))?.hash ?? ""))?.moderation,
    ).toBe("approved");
  });

  it("waits for a slow upload to finish", async () => {
    const { fetcher } = roblox({
      "/assets/v1/operations/": () =>
        json({
          done: true,
          response: { assetId: "8", moderationResult: { moderationState: "Approved" } },
        }),
      "/assets/v1/assets": () => json({ path: "operations/abc", done: false }),
    });
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toMatchObject({
      status: "added",
      assetId: "8",
    });
  });

  it("explains a refused key, a refused file and a busy Roblox, and never repeats the key", async () => {
    for (const [status, reason] of [
      [401, "key_rejected"],
      [429, "rate_limited"],
      [400, "file_rejected"],
      [500, "network"],
    ] as const) {
      const { fetcher } = roblox({ "/assets/v1/assets": () => json({ message: SECRET }, status) });
      const result = await sendModelToPlace(modelUrl, deps(fetcher));
      expect(result).toEqual({ status: "failed", reason });
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("says when Roblox took it but Studio couldn't add it, and only adds next time", async () => {
    const { fetcher, calls } = roblox();
    const insert = vi.fn(async () => {
      throw new Error("Studio closed");
    });
    expect(await sendModelToPlace(modelUrl, deps(fetcher, { insert }))).toEqual({
      status: "not_added",
      assetId: "555",
    });
    calls.length = 0;
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toMatchObject({ status: "added" });
    expect(calls.some((c) => c.includes("/assets/v1/assets"))).toBe(false);
  });

  it("sends nothing if the file changed after the preview", async () => {
    const { fetcher, calls } = roblox();
    await writeFile(new URL(modelUrl), "different bytes");
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toEqual({
      status: "failed",
      reason: "file_changed",
    });
    expect(calls).toEqual([]);
  });

  it("resumes instead of sending again when a check fails after Roblox took the file", async () => {
    let online = false;
    const { fetcher, calls } = roblox({
      "/assets/v1/operations/": () =>
        online
          ? json({
              done: true,
              response: { assetId: "8", moderationResult: { moderationState: "Approved" } },
            })
          : json({}, 503),
      "/assets/v1/assets": () => json({ path: "operations/abc", done: false }),
    });
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toEqual({
      status: "failed",
      reason: "network",
    });
    online = true;
    calls.length = 0;
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toMatchObject({
      status: "added",
      assetId: "8",
    });
    expect(calls.some((c) => c.startsWith("POST https://apis.roblox.com/assets"))).toBe(false);
  });

  it("keeps every record when uploads finish together", async () => {
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((hash) =>
        recordSentModel(sentFile, hash, { assetId: hash, moderation: "approved" }),
      ),
    );
    for (const hash of ["a", "b", "c", "d", "e"]) {
      expect((await readSentModel(sentFile, hash))?.assetId).toBe(hash);
    }
  });

  it("adds an approved model after uploads are turned off, without touching Roblox", async () => {
    const { fetcher, calls } = roblox();
    await sendModelToPlace(modelUrl, deps(fetcher));
    await forgetRobloxKey(keyFile);
    calls.length = 0;
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toMatchObject({
      status: "added",
      assetId: "555",
    });
    expect(calls).toEqual([]);
  });

  it("won't add an approved model to a Studio on another account", async () => {
    const { fetcher } = roblox();
    await sendModelToPlace(modelUrl, deps(fetcher));
    const insert = vi.fn(async () => "x");
    expect(
      await sendModelToPlace(modelUrl, deps(fetcher, { insert, studioAccount: async () => "2" })),
    ).toMatchObject({ status: "wrong_account" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("does nothing without a key or a file", async () => {
    const { fetcher } = roblox();
    await forgetRobloxKey(keyFile);
    expect(await sendModelToPlace(modelUrl, deps(fetcher))).toEqual({
      status: "failed",
      reason: "no_key",
    });
    expect(await sendModelToPlace("file:///nope/Gone.fbx", deps(fetcher))).toEqual({
      status: "failed",
      reason: "no_file",
    });
  });
});
