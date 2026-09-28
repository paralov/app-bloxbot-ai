// Authoring and publishing tool for BloxBot programs (see bloxbot-programs/README.md).
//
//   pnpm bloxbot-programs build             rebuild bloxbot-programs/manifest.json from sources
//   pnpm bloxbot-programs check             fail if manifest.json is out of date (CI)
//   pnpm bloxbot-programs test [name]       run programs against a live Roblox Studio
//   pnpm bloxbot-programs brief <name>      print what an author needs to (re)write a program
//   pnpm bloxbot-programs sign <dir>        sign manifest.json into <dir> (CI, needs the key)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Effect, JSONSchema, Schema } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { studioMcpCommand } from "../../electron/opencodeConfig";
import { BLOXBOT_PROGRAMS_MANIFEST_URL } from "../../electron/services/BloxBotProgramStore";
import { startGeneratedProgramRuntime } from "../../electron/services/GeneratedProgramRuntime";
import {
  signBloxBotProgramManifest,
  verifyBloxBotProgramManifest,
} from "../../electron/bloxbotProgramSignature";
import { ExplorerSnapshotSchema } from "../../src/lib/explorer";
import {
  allowedBloxBotProgramTools,
  buildBloxBotProgramManifest,
  BLOXBOT_PROGRAM_CONTRACTS,
  BLOXBOT_PROGRAM_NAMES,
  type BloxBotProgramName,
  serializeBloxBotProgramManifest,
} from "../../src/lib/bloxbotProgramManifest";
import type { GeneratedProgramEnvelope } from "../../src/types/generatedProgram";
import {
  expectedManifest,
  MANIFEST_PATH,
  readProgramFile,
  readSources,
  samePrograms,
} from "./manifestFiles";
import {
  StudioTargetDiscoverySchema,
  StudioTargetSelectionSchema,
} from "../../src/types/studioTarget";


// ── Manifest ────────────────────────────────────────────────────────────

async function build() {
  // Number changed programs past what is already published; offline, past the local copy.
  const published = await readPublishedManifest().catch(() => null);
  const manifest = await expectedManifest(published?.sequence ?? 0);
  await writeFile(MANIFEST_PATH, serializeBloxBotProgramManifest(manifest));
  console.log(`bloxbot-programs/manifest.json at sequence ${manifest.sequence}`);
}

async function check() {
  const expected = serializeBloxBotProgramManifest(await expectedManifest());
  const actual = await readProgramFile("manifest.json").catch(() => "");
  if (expected !== actual) {
    console.error("bloxbot-programs/manifest.json is out of date. Run: pnpm bloxbot-programs build");
    process.exit(1);
  }
  console.log("bloxbot-programs/manifest.json is up to date");
}

interface PublishedManifest {
  sequence: number;
  programs: unknown;
}

/**
 * The published manifest's sequence and programs, or null before the first
 * publish. Read loosely, so a manifest in an older format never blocks the
 * next publish.
 */
async function readPublishedManifest(): Promise<PublishedManifest | null> {
  const response = await fetch(BLOXBOT_PROGRAMS_MANIFEST_URL, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the published manifest (${response.status})`);
  const data = (await response.json().catch(() => ({}))) as Partial<PublishedManifest>;
  return {
    sequence: typeof data.sequence === "number" && Number.isFinite(data.sequence) ? data.sequence : 0,
    programs: data.programs ?? null,
  };
}

async function sign(outDir: string | undefined) {
  if (!outDir) throw new Error("Usage: bloxbot-programs sign <output-directory>");
  const key = process.env.BLOXBOT_PROGRAMS_SIGNING_KEY;
  if (!key) throw new Error("BLOXBOT_PROGRAMS_SIGNING_KEY is not set");
  await check();
  const committed = await expectedManifest();
  const published = await readPublishedManifest();
  if (published && samePrograms(published, committed)) {
    console.log(`Already published at sequence ${published.sequence}; nothing to sign`);
    return;
  }
  // Apps never go back to a lower sequence, so a revert (which restores an
  // older manifest.json) must still publish above what is already out there.
  const sequence = Math.max(committed.sequence, (published?.sequence ?? 0) + 1);
  const manifest = serializeBloxBotProgramManifest({ ...committed, sequence });
  const signature = signBloxBotProgramManifest(manifest, key);
  // Refuse to publish anything the app would reject.
  if (!verifyBloxBotProgramManifest(manifest, signature)) {
    throw new Error("The signing key does not match the public key pinned in the app");
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "manifest.json"), manifest);
  await writeFile(join(outDir, "manifest.json.sig"), `${signature}\n`);
  console.log(`Signed sequence ${sequence} into ${outDir}`);
}

// ── Live Studio ─────────────────────────────────────────────────────────

interface Studio {
  tools: Tool[];
  studioId: string;
  run(envelope: GeneratedProgramEnvelope, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

async function connectStudio(): Promise<Studio> {
  const [command, ...args] = studioMcpCommand(process.platform, {
    localAppData: process.env.LOCALAPPDATA,
    comSpec: process.env.ComSpec,
    systemRoot: process.env.SystemRoot,
  });
  const client = new Client({ name: "bloxbot-programs-cli", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command, args, cwd: homedir(), stderr: "pipe" }),
  );
  const callTool = async (name: string, toolArgs: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: toolArgs })) as CallToolResult;
  const { tools } = await client.listTools();
  // The same runtime and tool rules the app uses, with Studio's annotations.
  const runtime = startGeneratedProgramRuntime(
    callTool,
    async (name) => tools.find((tool) => tool.name === name),
    async () => tools,
  );

  const studios = parseStudios(await callTool("list_roblox_studios", {}));
  const wanted = process.env.STUDIO_NAME;
  const studio = wanted ? studios.find((s) => s.name.includes(wanted)) : studios[0];
  if (!studio) {
    await client.close();
    throw new Error("Open a place in Roblox Studio (set STUDIO_NAME to pick one of several)");
  }
  console.log(`Using Studio "${studio.name}"`);

  return {
    tools,
    studioId: studio.id,
    async run(envelope, input) {
      const artifact = await Effect.runPromise(runtime.compile(envelope));
      const result = await Effect.runPromise(runtime.invoke({ artifact, input }));
      return result.value;
    },
    close: () => client.close(),
  };
}

/**
 * Reads list_roblox_studios as forgivingly as the programs do: text or JSON
 * content, a note before the JSON, and id / studio_id / studioId.
 */
function parseStudios(result: CallToolResult): { id: string; name: string }[] {
  const part = result.content.find((item) => item.type === "text");
  const text = part && part.type === "text" ? part.text : "";
  const start = Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  let data: unknown;
  try {
    data = JSON.parse(Number.isFinite(start) ? text.slice(start) : text);
  } catch {
    return [];
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { studios?: unknown })?.studios)
      ? (data as { studios: unknown[] }).studios
      : [];
  return list.flatMap((entry) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const rawId = item.id ?? item.studio_id ?? item.studioId;
    const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId).trim() : "";
    if (!id) return [];
    const rawName = item.name ?? item.place_name ?? item.placeName;
    return [{ id, name: typeof rawName === "string" && rawName ? rawName : id }];
  });
}

/** Runs one program against Studio and checks its output like the app would. */
async function testProgram(
  studio: Studio,
  name: BloxBotProgramName,
  envelope: GeneratedProgramEnvelope,
): Promise<string> {
  switch (name) {
    case "studio-target-discovery": {
      const value = Schema.decodeUnknownSync(StudioTargetDiscoverySchema)(
        await studio.run(envelope, {}),
      );
      if (!value.targets.some((target) => target.key === studio.studioId)) {
        throw new Error(`Discovery did not list the open Studio (${studio.studioId})`);
      }
      return `${value.targets.length} Studio target(s)`;
    }
    case "studio-target-selection": {
      const value = Schema.decodeUnknownSync(StudioTargetSelectionSchema)(
        await studio.run(envelope, { targetKey: studio.studioId }),
      );
      return `selected ${value.selected.label}`;
    }
    case "explorer-snapshot": {
      const value = Schema.decodeUnknownSync(ExplorerSnapshotSchema)(
        await studio.run(envelope, { studioId: studio.studioId }),
      );
      if (value.roots.length === 0) throw new Error("Explorer returned no instances");
      return `${value.roots.length} services in "${value.placeName}"`;
    }
  }
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

async function test(only: string | undefined) {
  const names = only ? [programName(only, "test")] : BLOXBOT_PROGRAM_NAMES;
  // Built from the files on disk, so an edited program is tested before `build`.
  const manifest = buildBloxBotProgramManifest(await readSources(), 1);
  const studio = await connectStudio();
  let failed = false;
  try {
    for (const name of names) {
      try {
        console.log(`✓ ${name}: ${await testProgram(studio, name, manifest.programs[name])}`);
      } catch (error) {
        failed = true;
        console.error(`✗ ${name}: ${errorText(error)}`);
      }
    }
  } finally {
    await studio.close();
  }
  if (failed) process.exit(1);
}

// ── Authoring brief ─────────────────────────────────────────────────────
//
// Programs are written by the bloxbot-program-author agent in Claude Code
// (.claude/agents/bloxbot-program-author.md), not by an API call from here. The
// brief gives it everything this app knows about a program; `test` is its check.

const OUTPUT_SCHEMAS: Record<BloxBotProgramName, Schema.Schema.Any> = {
  "explorer-snapshot": ExplorerSnapshotSchema,
  "studio-target-discovery": StudioTargetDiscoverySchema,
  "studio-target-selection": StudioTargetSelectionSchema,
};

const INPUTS: Record<BloxBotProgramName, string> = {
  "explorer-snapshot": "{ studioId: string }: the Studio instance to read, as accepted by studio_id",
  "studio-target-discovery": "{}: no input",
  "studio-target-selection": "{ targetKey: string }: the studio_id of the target to verify",
};

function programName(name: string | undefined, command: string): BloxBotProgramName {
  if (!name || !BLOXBOT_PROGRAM_NAMES.includes(name as BloxBotProgramName)) {
    throw new Error(`Usage: bloxbot-programs ${command} <${BLOXBOT_PROGRAM_NAMES.join("|")}>`);
  }
  return name as BloxBotProgramName;
}

async function brief(name: string | undefined) {
  const program = programName(name, "brief");
  const sources = await readSources();
  const studio = await connectStudio();
  try {
    // Exactly the tools the runtime lets this program call, known or read-only.
    const tools = allowedBloxBotProgramTools(program, studio.tools);
    console.log(`# Brief: the "${program}" BloxBot program

Program file: bloxbot-programs/${program}.ts
Contract: ${JSON.stringify(BLOXBOT_PROGRAM_CONTRACTS[program])}
Input: ${INPUTS[program]}

## Rules the runtime enforces

- The file defines \`async function run({ input, callTool })\` and nothing is imported or exported.
- No globals beyond standard JavaScript, and no network or file access. Only callTool reaches Studio.
- callTool may only call: ${tools.map((tool) => tool.name).join(", ")}. Anything else is refused.
- callTool resolves to a raw MCP CallToolResult; when isError is true, content holds Studio's error text (it does not throw).
- Return only JSON-safe values. Throw an Error with a clear message when Studio can't provide the data.

## Helpers prepended to every program (bloxbot-programs/lib/mcp.ts; call, don't redefine)

\`\`\`ts
${sources.lib.trim()}
\`\`\`

## The return value must validate against this JSON Schema

\`\`\`json
${JSON.stringify(JSONSchema.make(OUTPUT_SCHEMAS[program]), null, 2)}
\`\`\`

## Studio MCP tools this program may call, as the open Studio describes them now

\`\`\`json
${JSON.stringify(
  tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
    name: toolName,
    description,
    inputSchema,
    annotations,
  })),
  null,
  2,
)}
\`\`\`

## The current program

\`\`\`ts
${sources.programs[program].trim()}
\`\`\`
`);
  } finally {
    await studio.close();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────

const [command, argument] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  build,
  check,
  test: () => test(argument),
  brief: () => brief(argument),
  sign: () => sign(argument),
};

const run = command ? commands[command] : undefined;
if (!run) {
  console.error(`Usage: bloxbot-programs <${Object.keys(commands).join("|")}>`);
  process.exit(1);
}
run().catch((error: unknown) => {
  console.error(errorText(error));
  process.exit(1);
});
