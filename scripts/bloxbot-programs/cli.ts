// Authoring and publishing tool for BloxBot programs (see bloxbot-programs/README.md).
//
//   pnpm bloxbot-programs build             rebuild bloxbot-programs/manifest.json from sources
//   pnpm bloxbot-programs check             fail if manifest.json is out of date (CI)
//   pnpm bloxbot-programs test              run every program against a live Roblox Studio
//   pnpm bloxbot-programs generate <name>   have Claude rewrite a program until it passes `test`
//   pnpm bloxbot-programs sign <dir>        sign manifest.json into <dir> (CI, needs the key)

import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Effect, JSONSchema, Schema } from "effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { studioMcpCommand } from "../../electron/opencodeConfig";
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
  type BloxBotProgramManifest,
  BloxBotProgramManifestSchema,
  type BloxBotProgramName,
  type BloxBotProgramSources,
  serializeBloxBotProgramManifest,
} from "../../src/lib/bloxbotProgramManifest";
import type { GeneratedProgramEnvelope } from "../../src/types/generatedProgram";
import {
  StudioTargetDiscoverySchema,
  StudioTargetSelectionSchema,
} from "../../src/types/studioTarget";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "bloxbot-programs");
const MANIFEST_PATH = join(DIR, "manifest.json");
const MODEL = "claude-opus-5";
const MAX_ATTEMPTS = 4;

// ── Sources and manifest ────────────────────────────────────────────────

async function readSources(): Promise<BloxBotProgramSources> {
  const programs = {} as Record<BloxBotProgramName, string>;
  for (const name of BLOXBOT_PROGRAM_NAMES) {
    programs[name] = await readFile(join(DIR, `${name}.ts`), "utf8");
  }
  return { lib: await readFile(join(DIR, "lib", "mcp.ts"), "utf8"), programs };
}

async function readShippedManifest(): Promise<BloxBotProgramManifest | null> {
  try {
    return Schema.decodeUnknownSync(BloxBotProgramManifestSchema)(
      JSON.parse(await readFile(MANIFEST_PATH, "utf8")),
    );
  } catch {
    return null;
  }
}

/** The manifest for the current sources; the sequence only moves when they change. */
async function expectedManifest(): Promise<BloxBotProgramManifest> {
  const sources = await readSources();
  const shipped = await readShippedManifest();
  const unchanged = buildBloxBotProgramManifest(sources, shipped?.sequence ?? 1);
  if (shipped && JSON.stringify(shipped.programs) === JSON.stringify(unchanged.programs)) {
    return shipped;
  }
  return buildBloxBotProgramManifest(sources, (shipped?.sequence ?? 0) + 1);
}

async function build() {
  const manifest = await expectedManifest();
  await writeFile(MANIFEST_PATH, serializeBloxBotProgramManifest(manifest));
  console.log(`bloxbot-programs/manifest.json at sequence ${manifest.sequence}`);
}

async function check() {
  const expected = serializeBloxBotProgramManifest(await expectedManifest());
  const actual = await readFile(MANIFEST_PATH, "utf8").catch(() => "");
  if (expected !== actual) {
    console.error("bloxbot-programs/manifest.json is out of date. Run: pnpm bloxbot-programs build");
    process.exit(1);
  }
  console.log("bloxbot-programs/manifest.json is up to date");
}

async function sign(outDir: string | undefined) {
  if (!outDir) throw new Error("Usage: bloxbot-programs sign <output-directory>");
  const key = process.env.BLOXBOT_PROGRAMS_SIGNING_KEY;
  if (!key) throw new Error("BLOXBOT_PROGRAMS_SIGNING_KEY is not set");
  await check();
  const manifest = await readFile(MANIFEST_PATH, "utf8");
  const signature = signBloxBotProgramManifest(manifest, key);
  // Refuse to publish anything the app would reject.
  if (!verifyBloxBotProgramManifest(manifest, signature)) {
    throw new Error("The signing key does not match the public key pinned in the app");
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "manifest.json"), manifest);
  await writeFile(join(outDir, "manifest.json.sig"), `${signature}\n`);
  console.log(`Signed manifest into ${outDir}`);
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
  // The same runtime (and tool allow-list) the app uses.
  const runtime = startGeneratedProgramRuntime(callTool);
  const { tools } = await client.listTools();

  const listed = (await callTool("list_roblox_studios", {})).content;
  const text = Array.isArray(listed) && listed[0]?.type === "text" ? listed[0].text : "{}";
  const studios = (JSON.parse(text) as { studios?: { id: string; name: string }[] }).studios ?? [];
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

async function test() {
  const manifest = await expectedManifest();
  const studio = await connectStudio();
  let failed = false;
  try {
    for (const name of BLOXBOT_PROGRAM_NAMES) {
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

// ── Generation with Claude ──────────────────────────────────────────────

const OUTPUT_SCHEMAS: Record<BloxBotProgramName, Schema.Schema.Any> = {
  "explorer-snapshot": ExplorerSnapshotSchema,
  "studio-target-discovery": StudioTargetDiscoverySchema,
  "studio-target-selection": StudioTargetSelectionSchema,
};

const INPUTS: Record<BloxBotProgramName, string> = {
  "explorer-snapshot": "{ studioId: string } — the Studio instance to read, as accepted by studio_id",
  "studio-target-discovery": "{} — no input",
  "studio-target-selection": "{ targetKey: string } — the studio_id of the target to verify",
};

function extractSource(text: string): string | null {
  const match = text.match(/```(?:ts|typescript)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}

async function generate(name: string | undefined) {
  if (!name || !BLOXBOT_PROGRAM_NAMES.includes(name as BloxBotProgramName)) {
    throw new Error(`Usage: bloxbot-programs generate <${BLOXBOT_PROGRAM_NAMES.join("|")}>`);
  }
  const program = name as BloxBotProgramName;
  const sources = await readSources();
  const studio = await connectStudio();
  const allowed = allowedBloxBotProgramTools(program);
  const tools = studio.tools.filter((tool) => allowed.includes(tool.name));

  const system = `You write small TypeScript programs that BloxBot, a desktop app for Roblox development, runs against the Roblox Studio MCP server.

A program is a single self-contained source that defines:

async function run({ input, callTool }: { input: any; callTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }): Promise<unknown>

Rules the runtime enforces:
- No imports or exports, no globals beyond standard JavaScript, no network or file access. Only callTool reaches Studio.
- callTool may only call these tools: ${allowed.join(", ")}. Any other tool is refused.
- callTool resolves to a raw MCP CallToolResult. When isError is true, content holds Studio's error text; errors are not thrown.
- Return only JSON-safe values. Throw an Error with a clear message when Studio can't provide the data.

These helpers are prepended to every program, so call them without redefining them:

\`\`\`ts
${sources.lib.trim()}
\`\`\``;

  const task = `Write the "${program}" program (contract ${JSON.stringify(BLOXBOT_PROGRAM_CONTRACTS[program])}).

Input: ${INPUTS[program]}

The return value must validate against this JSON Schema:
${JSON.stringify(JSONSchema.make(OUTPUT_SCHEMAS[program]), null, 2)}

The Studio MCP tools it may call, with their current schemas:
${JSON.stringify(tools.map(({ name: toolName, description, inputSchema }) => ({ name: toolName, description, inputSchema })), null, 2)}

The current program, which you should keep where it still fits Studio's tools:
\`\`\`ts
${sources.programs[program].trim()}
\`\`\`

Reply with the complete program (without the prepended helpers) in a single \`\`\`ts code block.`;

  const client = new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: task }];
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(`Attempt ${attempt}: asking ${MODEL}…`);
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system,
        messages,
      });
      if (response.stop_reason === "refusal") {
        throw new Error(`The model declined: ${response.stop_details?.explanation ?? "no reason given"}`);
      }
      // Append the whole turn, thinking included, so the conversation stays append-only.
      messages.push({ role: "assistant", content: response.content });
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      const candidate = extractSource(text);
      if (!candidate) {
        messages.push({ role: "user", content: "Reply with the program in a single ```ts code block." });
        continue;
      }

      const envelope = buildBloxBotProgramManifest(
        { ...sources, programs: { ...sources.programs, [program]: candidate } },
        1,
      ).programs[program];
      try {
        const summary = await testProgram(studio, program, envelope);
        await writeFile(join(DIR, `${program}.ts`), `${candidate}\n`);
        await build();
        console.log(`✓ ${program}: ${summary}. Wrote bloxbot-programs/${program}.ts; review and open a PR.`);
        return;
      } catch (error) {
        const failure = errorText(error);
        console.error(`✗ Attempt ${attempt} failed: ${failure}`);
        messages.push({
          role: "user",
          content: `Running that program against the open Studio failed:\n\n${failure}\n\nFix it and reply with the complete program in a single \`\`\`ts code block.`,
        });
      }
    }
    throw new Error(`No working ${program} program after ${MAX_ATTEMPTS} attempts`);
  } finally {
    await studio.close();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────

const [command, argument] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  build,
  check,
  test,
  generate: () => generate(argument),
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
