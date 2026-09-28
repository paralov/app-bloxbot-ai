# BloxBot programs

Small TypeScript programs BloxBot runs against the Roblox Studio MCP: the Explorer
tree (`explorer-snapshot`) and finding and verifying the Studio to work in
(`studio-target-discovery`, `studio-target-selection`).

When Roblox changes the Studio MCP, fix the program here and merge. The
BloxBot programs workflow signs and publishes it, and installed apps pick it up
within six hours, with no app release.

## How BloxBot picks a program

1. The newest published copy, if it is newer than the one the app shipped with
   and its contract matches what the app understands.
2. The copy the app shipped with (`manifest.json`, built from this folder).
3. If that fails on first use, a program written by the user's own model.

Published copies are Ed25519-signed by the workflow (secret
`BLOXBOT_PROGRAMS_SIGNING_KEY`) and verified against the public key pinned in
`electron/bloxbotProgramSignature.ts`. The app keeps the last verified copy and
never accepts a lower `sequence` than it already has.

Programs run in the app's program runtime and may only call the read-only Studio
tools listed in `src/lib/bloxbotProgramManifest.ts`, whoever wrote them.

## Changing a program

Open a place in Roblox Studio, then:

```sh
pnpm bloxbot-programs test                     # run every program against Studio
pnpm bloxbot-programs test explorer-snapshot   # run one
pnpm bloxbot-programs brief explorer-snapshot  # contract, output schema, Studio's current tools, source
pnpm bloxbot-programs build                    # rebuild manifest.json after editing a program
```

To have a program written or repaired, ask Claude Code to use the
`bloxbot-program-author` agent (`.claude/agents/bloxbot-program-author.md`), for
example: "use the bloxbot-program-author agent to fix explorer-snapshot". It
reads the brief, edits the program, and runs `test` against the open Studio
until it passes, using the session's own model. No API key is needed. Set
`STUDIO_NAME` to pick one of several open places.

Review the change, commit the program and `manifest.json` together, and open a
PR. CI fails if `manifest.json` is out of date or would be rejected by the app.

A program's contract (its input and output shape) only changes with an app
release: bump it in `BLOXBOT_PROGRAM_CONTRACTS`, and older apps keep using the
program they understand.
