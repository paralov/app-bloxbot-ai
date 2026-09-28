import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import { Context, Data, Effect, Layer, Schema } from "effect";
import { transform } from "sucrase";

import {
  type GeneratedProgramArtifact,
  GeneratedProgramArtifactSchema,
  type GeneratedProgramEnvelope,
  GeneratedProgramEnvelopeSchema,
  type GeneratedProgramInvocation,
  GeneratedProgramInvocationSchema,
  type GeneratedProgramResult,
  GeneratedProgramResultSchema,
} from "../../src/types/generatedProgram";
import {
  allowedBloxBotProgramTools,
  BLOXBOT_PROGRAM_TOOLS,
  type BloxBotProgramName,
  isKnownBloxBotProgramTool,
  isReadOnlyStudioTool,
  type StudioToolAnnotations,
  studioToolName,
} from "../../src/lib/bloxbotProgramManifest";
import { StudioMcpBroker } from "./StudioMcpBroker";

type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
/** Studio's annotations for a tool, or undefined when Studio doesn't list it. */
export type DescribeTool = (
  name: string,
) => Promise<{ annotations?: StudioToolAnnotations } | undefined>;
/** The tools Studio lists now, with their annotations. */
export type ListTools = () => Promise<
  readonly { name: string; annotations?: StudioToolAnnotations }[]
>;
type ProgramFunction = (input: unknown, callTool: CallTool) => Promise<unknown>;

export type GeneratedProgramFailurePhase =
  | "compile"
  | "tool-contract"
  | "runtime"
  | "output";

export class GeneratedProgramRuntimeError extends Data.TaggedError(
  "GeneratedProgramRuntimeError",
)<{
  message: string;
  phase: GeneratedProgramFailurePhase;
  regenerate: true;
  cause?: unknown;
}> {}

export interface GeneratedProgramRuntimeService {
  readonly compile: (
    envelope: GeneratedProgramEnvelope,
  ) => Effect.Effect<GeneratedProgramArtifact, GeneratedProgramRuntimeError>;
  readonly invoke: (
    invocation: GeneratedProgramInvocation,
  ) => Effect.Effect<GeneratedProgramResult, GeneratedProgramRuntimeError>;
  /**
   * The tools a program may call, by Studio's own name: those Studio lists now
   * that the allow rule accepts, or the program's known tools when Studio
   * lists none.
   */
  readonly allowedTools: (program: BloxBotProgramName) => Effect.Effect<string[]>;
}

export class GeneratedProgramRuntime extends Context.Tag("@bloxbot/GeneratedProgramRuntime")<
  GeneratedProgramRuntime,
  GeneratedProgramRuntimeService
>() {}

class ToolContractError extends Error {}

const TOOL_LIST_TTL_MS = 30_000;

function runtimeError(
  phase: GeneratedProgramFailurePhase,
  message: string,
  cause: unknown,
) {
  return new GeneratedProgramRuntimeError({ phase, message, regenerate: true, cause });
}

function withCause(message: string, cause: unknown): string {
  return cause instanceof Error && cause.message ? `${message}: ${cause.message}` : message;
}

function cacheKey(envelope: GeneratedProgramEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify(envelope.contract))
    .update("\0")
    .update(envelope.source)
    .digest("hex");
}

function makeFunction(compiledSource: string): ProgramFunction {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => ProgramFunction;
  return new AsyncFunction(
    "input",
    "callTool",
    `"use strict";\n${compiledSource}\nif (typeof run !== "function") throw new Error("Generated program must define async function run({ input, callTool })");\nreturn await run({ input, callTool });`,
  );
}

export function startGeneratedProgramRuntime(
  callTool: CallTool,
  describeTool: DescribeTool = async () => undefined,
  listTools: ListTools = async () => [],
): GeneratedProgramRuntimeService {
  const artifacts = new Map<string, GeneratedProgramArtifact>();
  const functions = new Map<string, ProgramFunction>();

  const compile = async (candidate: GeneratedProgramEnvelope) => {
    const envelope = await Schema.decodeUnknownPromise(GeneratedProgramEnvelopeSchema)(candidate);
    const key = cacheKey(envelope);
    const cached = artifacts.get(key);
    if (cached) return cached;
    if (/\b(?:import|export)\b/u.test(envelope.source)) {
      throw new Error("Generated programs must be import-free");
    }
    const compiledSource = transform(envelope.source, { transforms: ["typescript"] }).code;
    const artifact = await Schema.decodeUnknownPromise(GeneratedProgramArtifactSchema)({
      cacheKey: key,
      contract: envelope.contract,
      compiledSource,
    });
    functions.set(key, makeFunction(compiledSource));
    artifacts.set(key, artifact);
    return artifact;
  };

  return {
    allowedTools: (program) =>
      Effect.promise(async () => {
        const listed = await listTools().catch(() => []);
        return listed.length > 0
          ? allowedBloxBotProgramTools(program, listed).map((tool) => tool.name)
          : [...BLOXBOT_PROGRAM_TOOLS[program]];
      }),
    compile: (envelope) =>
      Effect.tryPromise({
        try: () => compile(envelope),
        catch: (cause) =>
          runtimeError("compile", withCause("Generated program did not compile", cause), cause),
      }),
    invoke: (candidate) =>
      Effect.gen(function* () {
        const invocation = yield* Schema.decodeUnknown(GeneratedProgramInvocationSchema)(
          candidate,
        ).pipe(
          Effect.mapError((cause) =>
            runtimeError("runtime", "Generated program invocation is invalid", cause),
          ),
        );
        let program = functions.get(invocation.artifact.cacheKey);
        if (!program) {
          program = yield* Effect.try({
            try: () => makeFunction(invocation.artifact.compiledSource),
            catch: (cause) =>
              runtimeError("compile", "Cached generated program is invalid", cause),
          });
          functions.set(invocation.artifact.cacheKey, program);
        }
        const contractName = invocation.artifact.contract.name;
        const guardedCallTool: CallTool = async (requestedName, args) => {
          // A model-written program may use OpenCode's name for a tool
          // (roblox-studio_search_game_tree). The rule below and Studio both
          // see Studio's own name, so the prefix never changes what's allowed.
          const name = studioToolName(requestedName);
          // Programs may only read from Studio, whoever wrote them.
          const allowed =
            isKnownBloxBotProgramTool(contractName, name) ||
            (contractName in BLOXBOT_PROGRAM_TOOLS &&
              isReadOnlyStudioTool((await describeTool(name))?.annotations));
          if (!allowed) {
            throw new ToolContractError(`${contractName} programs may not call ${requestedName}`);
          }
          try {
            return await callTool(name, args);
          } catch (cause) {
            throw new ToolContractError(
              cause instanceof Error ? cause.message : "Studio MCP tool call failed",
            );
          }
        };
        const value = yield* Effect.tryPromise({
          try: () => program(invocation.input, guardedCallTool),
          // Keep the program's own message (such as Studio's error text) in the
          // message itself, since only the message crosses the IPC bridge.
          catch: (cause) =>
            cause instanceof ToolContractError
              ? runtimeError("tool-contract", withCause("Generated program tool contract failed", cause), cause)
              : runtimeError("runtime", withCause("Generated program execution failed", cause), cause),
        });
        const jsonValue = yield* Effect.try({
          try: () => {
            const json = JSON.stringify(value);
            if (json === undefined) throw new Error("Output is not JSON serializable");
            return JSON.parse(json) as unknown;
          },
          catch: (cause) =>
            runtimeError("output", withCause("Generated program output is invalid", cause), cause),
        });
        return yield* Schema.decodeUnknown(GeneratedProgramResultSchema)({
          contract: invocation.artifact.contract,
          value: jsonValue,
        }).pipe(
          Effect.mapError((cause) =>
            runtimeError("output", "Generated program result schema failed", cause),
          ),
        );
      }),
  };
}

export const GeneratedProgramRuntimeLive = Layer.effect(
  GeneratedProgramRuntime,
  Effect.gen(function* () {
    const broker = yield* StudioMcpBroker;
    // Studio's tool list, reused briefly so a looping program can't flood Studio
    // with list requests, and refreshed often enough that changed annotations or
    // renamed tools apply within seconds.
    let cached: {
      tools: Map<string, { name: string; annotations?: StudioToolAnnotations }>;
      at: number;
    } | null = null;
    const listTools = async () => {
      if (!cached || Date.now() - cached.at > TOOL_LIST_TTL_MS) {
        const listed = await Effect.runPromise(broker.listTools);
        cached = { tools: new Map(listed.map((tool) => [tool.name, tool])), at: Date.now() };
      }
      return cached.tools;
    };
    return startGeneratedProgramRuntime(
      (name, args) => Effect.runPromise(broker.callTool(name, args)),
      async (name) => {
        try {
          return (await listTools()).get(name);
        } catch {
          return undefined;
        }
      },
      async () => [...(await listTools()).values()],
    );
  }),
);
