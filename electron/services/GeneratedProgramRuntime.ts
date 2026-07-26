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
import { StudioMcpBroker } from "./StudioMcpBroker";

type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
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
}

export class GeneratedProgramRuntime extends Context.Tag("@bloxbot/GeneratedProgramRuntime")<
  GeneratedProgramRuntime,
  GeneratedProgramRuntimeService
>() {}

class ToolContractError extends Error {}

function runtimeError(
  phase: GeneratedProgramFailurePhase,
  message: string,
  cause: unknown,
) {
  return new GeneratedProgramRuntimeError({ phase, message, regenerate: true, cause });
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

export function startGeneratedProgramRuntime(callTool: CallTool): GeneratedProgramRuntimeService {
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
    compile: (envelope) =>
      Effect.tryPromise({
        try: () => compile(envelope),
        catch: (cause) => runtimeError("compile", "Generated program did not compile", cause),
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
        const guardedCallTool: CallTool = async (name, args) => {
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
          catch: (cause) =>
            cause instanceof ToolContractError
              ? runtimeError("tool-contract", "Generated program tool contract failed", cause)
              : runtimeError("runtime", "Generated program execution failed", cause),
        });
        const jsonValue = yield* Effect.try({
          try: () => {
            const json = JSON.stringify(value);
            if (json === undefined) throw new Error("Output is not JSON serializable");
            return JSON.parse(json) as unknown;
          },
          catch: (cause) => runtimeError("output", "Generated program output is invalid", cause),
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
    return startGeneratedProgramRuntime((name, args) =>
      Effect.runPromise(broker.callTool(name, args)),
    );
  }),
);
