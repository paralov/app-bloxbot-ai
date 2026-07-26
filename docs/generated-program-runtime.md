# Generated TypeScript runtime

Agent-generated collectors and selectors use one generic contract. The agent returns a
`GeneratedProgramEnvelope` containing import-free TypeScript plus explicit contract, input, and
output schema versions. `GeneratedProgramRuntime.compile` transpiles it once and returns a
persistable `GeneratedProgramArtifact`; repeated compiles reuse the in-memory artifact cache.

The source must define:

```ts
async function run({ input, callTool }) {
  const result = await callTool("tool_selected_by_the_agent", { value: input.value });
  return { result };
}
```

`GeneratedProgramRuntime.invoke` restores the compiled function from the artifact when necessary,
passes only the invocation input and trusted Studio broker `callTool` capability, and returns a
JSON-serializable `GeneratedProgramResult`. Consumers validate `value` against their own versioned
Effect schema.

All failures have `regenerate: true` and a `phase` of `compile`, `tool-contract`, `runtime`, or
`output`. Callers should ask the agent for a replacement envelope only for these failures; routine
invocations do not use model inference.
