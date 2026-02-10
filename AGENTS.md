# AGENTS.md

This file provides guidance for AI coding agents operating in this repository.

## Project Overview

**BloxBot** (bloxbot.ai) — a Tauri v2 desktop app that bundles a Roblox MCP server
and Studio plugin into a single installer for easy AI-assisted Roblox development.

- **Frontend**: React 18, TypeScript ~5.6, Vite 6, ES Modules
- **Backend**: Rust (edition 2021), Tauri 2
- **MCP server**: [boshyxd/robloxstudio-mcp](https://github.com/boshyxd/robloxstudio-mcp) (TypeScript, managed as child process)
- **Package manager**: pnpm (do NOT use npm or yarn)
- **Monorepo layout**: frontend in `src/`, Rust backend in `src-tauri/`
- **Target platforms**: macOS, Windows

## Build / Dev / Test Commands

### Frontend

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Vite dev server (port 1420) |
| `pnpm build` | Type-check with `tsc` then bundle with `vite build` |
| `pnpm preview` | Preview production build locally |
| `pnpm tsc --noEmit` | Type-check only (no output) |

### Tauri (full app)

| Command | Description |
|---------|-------------|
| `pnpm tauri dev` | Run the full Tauri app in development mode |
| `pnpm tauri build` | Build the production Tauri app bundle |

### Rust Backend

All Rust commands must be run from the `src-tauri/` directory.

| Command | Description |
|---------|-------------|
| `cargo build` | Compile the Rust backend |
| `cargo check` | Fast type/borrow check without full compilation |
| `cargo clippy` | Lint Rust code (no config file; uses defaults) |
| `cargo fmt --check` | Check Rust formatting (no config file; uses defaults) |
| `cargo fmt` | Auto-format Rust code |
| `cargo test` | Run all Rust tests |
| `cargo test test_name` | Run a single Rust test by name |
| `cargo test -- --nocapture` | Run tests with stdout visible |

### Testing

**No test framework is currently installed.** When adding tests:

- **Frontend**: Use [Vitest](https://vitest.dev/) (native Vite integration). Install with `pnpm add -D vitest`. Place test files alongside source as `*.test.ts` or `*.test.tsx`. Run a single test with `pnpm vitest run src/path/to/file.test.tsx`.
- **Rust**: Use the built-in `#[cfg(test)]` module convention in each `.rs` file. Run a single test with `cargo test test_function_name` from `src-tauri/`.

### Linting & Formatting

[Biome](https://biomejs.dev/) is configured via `biome.json`. TypeScript strict mode in `tsconfig.json` provides additional enforcement.

| Command | Description |
|---------|-------------|
| `pnpm lint` | Check for lint/format issues in `src/` |
| `pnpm lint:fix` | Auto-fix lint/format issues in `src/` |

## Code Style — TypeScript / React

### Formatting

- **Indentation**: 2 spaces
- **Quotes**: double quotes for strings and imports
- **Semicolons**: always
- **Trailing commas**: yes (in multi-line constructs)
- **Line width**: ~80-100 characters (no hard limit configured)

### Imports

Order imports in this sequence, separated by blank lines:

1. React / framework imports (`react`, `react-dom`)
2. Third-party library imports (`@tauri-apps/api`, etc.)
3. Local module imports (relative paths)
4. Side-effect imports (CSS files)

```typescript
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import reactLogo from "./assets/react.svg";
import "./App.css";
```

### Components & Functions

- Use **function declarations** for React components (not arrow functions)
- Use `export default ComponentName;` at the bottom of the file (one component per file)
- Use `async function` for async operations inside components
- Hooks go at the top of the component body

```typescript
function App() {
  const [name, setName] = useState("");

  async function greet() {
    const result = await invoke("greet", { name });
  }

  return <main>...</main>;
}

export default App;
```

### Types

- TypeScript strict mode is enabled — do not use `any` without justification
- `tsconfig.json` enforces: `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Use type assertions sparingly: `document.getElementById("root") as HTMLElement`
- Prefer interfaces for object shapes, type aliases for unions/intersections
- All Tauri `invoke` calls should have typed return values

### Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| React components | PascalCase | `App`, `SettingsPanel` |
| Functions / variables | camelCase | `greetMsg`, `setName` |
| CSS classes | kebab-case | `greet-input`, `logo-row` |
| Files (components) | PascalCase.tsx | `App.tsx`, `Settings.tsx` |
| Files (utilities) | camelCase.ts | `helpers.ts`, `apiClient.ts` |
| Constants | UPPER_SNAKE_CASE | `MAX_RETRIES` |

### Error Handling

- Use try/catch for async `invoke` calls to the Rust backend
- Display user-facing errors in the UI, log technical details to console
- Never silently swallow errors

## Code Style — Rust

### Formatting

- **Indentation**: 4 spaces (Rust standard)
- **Formatter**: `cargo fmt` (default rustfmt settings)
- **Linter**: `cargo clippy` (default settings)

### Tauri Commands

- Annotate with `#[tauri::command]`
- Use `snake_case` for function names
- Return `Result<T, String>` for fallible commands (or use a custom error type with `serde::Serialize`)
- Register commands in `invoke_handler(tauri::generate_handler![...])` in `lib.rs`

```rust
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
```

### Project Structure

- `src-tauri/src/main.rs` — entry point, calls `bloxbot_lib::run()`
- `src-tauri/src/lib.rs` — Tauri builder setup and command registration
- Add new modules in `src-tauri/src/` and declare them with `mod` in `lib.rs`

### Error Handling

- Use `Result` types for functions that can fail
- Use `?` operator for error propagation
- Reserve `.expect()` / `.unwrap()` for truly unrecoverable scenarios (app startup)
- For Tauri commands, return `Result<T, String>` so errors propagate to the frontend

### Naming Conventions

| Item | Convention | Example |
|------|-----------|---------|
| Functions | snake_case | `greet`, `fetch_data` |
| Structs / Enums | PascalCase | `AppState`, `UserRole` |
| Constants | UPPER_SNAKE_CASE | `MAX_CONNECTIONS` |
| Modules / files | snake_case | `mod database;` |

## Key File Paths

| Path | Purpose |
|------|---------|
| `src/` | React/TypeScript frontend source |
| `src/main.tsx` | Frontend entry point |
| `src/App.tsx` | Root React component |
| `src-tauri/` | Rust backend source |
| `src-tauri/src/lib.rs` | Tauri app setup and commands |
| `src-tauri/src/main.rs` | Rust binary entry point |
| `src-tauri/tauri.conf.json` | Tauri configuration |
| `src-tauri/Cargo.toml` | Rust dependencies |
| `package.json` | Frontend dependencies and scripts |
| `tsconfig.json` | TypeScript configuration |
| `vite.config.ts` | Vite bundler configuration |
