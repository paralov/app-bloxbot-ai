Place platform-specific sidecar binaries here with target-triple suffixes.

Get your target triple: `rustc --print host-tuple`

Required binaries:

- `bun-<target-triple>` (from https://bun.sh/docs/installation)
- `opencode-<target-triple>` (from https://opencode.ai)

Example for Apple Silicon Mac:

- `bun-aarch64-apple-darwin`
- `opencode-aarch64-apple-darwin`

These files are listed in `.gitignore` and not committed to the repository.
Tauri bundles them via the `externalBin` config and strips the target-triple
suffix at build time.
