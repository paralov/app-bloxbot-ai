Place platform-specific sidecar binaries here with target-triple suffixes.

Get your target triple: `rustc --print host-tuple`

Required binaries:

- `opencode-<target-triple>` (from https://opencode.ai)

Example for Apple Silicon Mac:

- `opencode-aarch64-apple-darwin`

## Download Instructions

### OpenCode

Download from https://github.com/anomalyco/opencode/releases

## Node.js Runtime

Node.js is bundled as a resource (not a sidecar) in `resources/nodejs/`.
It includes the full Node.js runtime with npm and npx.

For local development, download from https://nodejs.org and extract to:
`src-tauri/resources/nodejs/` maintaining the `bin/` and `lib/` structure.

Example for macOS ARM64:
```bash
curl -fsSL https://nodejs.org/dist/v22.13.1/node-v22.13.1-darwin-arm64.tar.gz | tar -xz
mkdir -p ../resources/nodejs
cp -R node-v22.13.1-darwin-arm64/bin ../resources/nodejs/
mkdir -p ../resources/nodejs/lib/node_modules
cp -R node-v22.13.1-darwin-arm64/lib/node_modules/npm ../resources/nodejs/lib/node_modules/
rm -rf node-v22.13.1-darwin-arm64
```

These files are listed in `.gitignore` and not committed to the repository.
Tauri bundles them via the `externalBin` and `resources` config.
