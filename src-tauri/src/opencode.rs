//! OpenCode server management.
//!
//! Starts the OpenCode server as a child process on app launch and emits
//! Tauri events when its status changes. The frontend never polls -- it
//! just listens for `opencode-status-changed` events.
//!
//! All process spawning goes through `tauri-plugin-shell`, which provides
//! sidecar resolution, event-based stdout/stderr, and cross-platform
//! process management (including hiding console windows on Windows).

use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// BloxBot's reserved port ranges within the IANA dynamic/private range
/// (49152-65535). Each block is 10 ports; the app binds to the first
/// available port in each block.
///
/// 59200-59209: OpenCode server (HTTP API)
/// 59210-59219: MCP bridge (Studio plugin ↔ MCP server)
/// 59220-59229: MCP launcher control endpoint
const OC_PORT_START: u16 = 59200;
const MCP_PORT_START: u16 = 59210;
const PORT_RANGE: u16 = 10;

/// All servers bind to IPv4 loopback. Using `"localhost"` is **not**
/// safe because macOS resolves it to `[::1]` (IPv6), causing our IPv4
/// health checks to fail with "connection refused".
pub const LOOPBACK: &str = "127.0.0.1";

/// Shared HTTP client — reuses connections across poll calls.
fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build()
            .unwrap_or_default()
    })
}

// ── Status ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub enum OpenCodeStatus {
    Stopped,
    Starting,
    Running,
    Error(String),
}

/// Payload emitted with the `opencode-status-changed` event.
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatusPayload {
    pub status: OpenCodeStatus,
    pub port: u16,
}

// ── State ───────────────────────────────────────────────────────────────

pub struct OpenCodeState {
    pub status: OpenCodeStatus,
    pub port: u16,
    pub mcp_port: u16,
    pub(crate) child: Option<CommandChild>,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        Self {
            status: OpenCodeStatus::Stopped,
            port: 0,
            mcp_port: 0,
            child: None,
        }
    }
}

pub type SharedOpenCodeState = Arc<Mutex<OpenCodeState>>;

// ── Helpers ─────────────────────────────────────────────────────────────

/// Emit a status change event to the frontend.
fn emit_status(app: &AppHandle, status: &OpenCodeStatus, port: u16) {
    let _ = app.emit(
        "opencode-status-changed",
        StatusPayload {
            status: status.clone(),
            port,
        },
    );
}

/// Update the state and emit the event in one step.
async fn set_status(state: &SharedOpenCodeState, app: &AppHandle, status: OpenCodeStatus) {
    let port;
    {
        let mut s = state.lock().await;
        s.status = status.clone();
        port = s.port;
    }
    emit_status(app, &status, port);
}

/// Find the first available TCP port starting from `start`, trying
/// up to `PORT_RANGE` consecutive ports. All servers bind to `LOOPBACK`
/// (127.0.0.1), so we only need to probe that address.
async fn find_available_port(start: u16) -> u16 {
    for port in start..start.saturating_add(PORT_RANGE) {
        if tokio::net::TcpListener::bind((LOOPBACK, port))
            .await
            .is_ok()
        {
            return port;
        }
        log::debug!("Port {port} unavailable, skipping");
    }
    log::error!("All ports {start}-{} are unavailable!", start.saturating_add(PORT_RANGE - 1));
    start // fallback — let the spawn surface the real error
}

/// Strip the Windows extended-length path prefix (`\\?\`) from a path string.
/// These prefixes are returned by `std::fs::canonicalize` / Tauri resource resolution
/// but break when used in the `PATH` env var or passed to other programs.
#[cfg(windows)]
fn strip_win_prefix(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

// ── Startup cleanup ─────────────────────────────────────────────────────

/// Kill any stale processes listening on our reserved port ranges
/// (59200-59229). This handles the case where BloxBot crashed or was
/// force-quit, leaving orphan processes holding ports.
///
/// Covers all three ranges:
/// - 59200-59209: OpenCode server
/// - 59210-59219: MCP bridge
/// - 59220-59229: Launcher control endpoint
///
/// Uses platform-specific commands:
/// - macOS/Linux: `lsof -ti tcp:PORT` to find PIDs, then `kill -9`
/// - Windows: `netstat -ano` to find PIDs, then `taskkill /F /PID`
pub fn cleanup_stale_processes() {
    let start = OC_PORT_START; // 59200
    let end = OC_PORT_START + PORT_RANGE * 3; // 59230 (covers 59200-59229)
    log::info!("Checking for stale processes on ports {start}-{}", end - 1);

    #[cfg(unix)]
    {
        let mut killed = 0u32;
        for port in start..end {
            let output = std::process::Command::new("lsof")
                .args(["-ti", &format!("tcp:{port}")])
                .output();

            if let Ok(out) = output {
                let pids = String::from_utf8_lossy(&out.stdout);
                for pid_str in pids.split_whitespace() {
                    if let Ok(pid) = pid_str.trim().parse::<u32>() {
                        log::info!("Killing stale process PID {pid} on port {port}");
                        let _ = std::process::Command::new("kill")
                            .args(["-9", &pid.to_string()])
                            .output();
                        killed += 1;
                    }
                }
            }
        }
        if killed > 0 {
            log::info!("Killed {killed} stale process(es)");
        } else {
            log::info!("No stale processes found");
        }
    }

    #[cfg(windows)]
    {
        // Parse netstat output to find PIDs listening on our ports.
        let output = std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for port in start..end {
                let needle = format!("{}:{}", LOOPBACK, port);
                for line in text.lines() {
                    if line.contains(&needle) && line.contains("LISTENING") {
                        // Last column is the PID
                        if let Some(pid_str) = line.split_whitespace().last() {
                            if let Ok(pid) = pid_str.parse::<u32>() {
                                if pid > 0 {
                                    log::info!("Killing stale process PID {pid} on port {port}");
                                    let _ = std::process::Command::new("taskkill")
                                        .args(["/F", "/PID", &pid.to_string()])
                                        .output();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── Core lifecycle ──────────────────────────────────────────────────────

/// Start the OpenCode server. Called automatically on app launch.
///
/// Uses `tauri-plugin-shell` sidecar support to spawn the bundled
/// `opencode` binary. stdout/stderr and process exit are handled via
/// the shell plugin's event channel, replacing manual BufReader capture
/// and polling-based exit monitoring.
pub async fn start_opencode_server(
    state: SharedOpenCodeState,
    app: AppHandle,
) -> Result<u16, String> {
    // Guard: don't double-start
    {
        let current = state.lock().await;
        if matches!(
            current.status,
            OpenCodeStatus::Running | OpenCodeStatus::Starting
        ) {
            return Ok(current.port);
        }
    }

    let nodejs_bin_dir = match crate::paths::bundled_nodejs_bin_dir() {
        Ok(dir) => dir,
        Err(e) => {
            log::error!("Failed to find Node.js: {e}");
            set_status(&state, &app, OpenCodeStatus::Error(e.clone())).await;
            return Err(e);
        }
    };
    log::info!("Node.js bin: {}", nodejs_bin_dir.display());

    set_status(&state, &app, OpenCodeStatus::Starting).await;

    // Run the actual startup logic. If anything fails after this point,
    // transition status to Error so the frontend can show a retry button
    // instead of being stuck on "Starting up..." forever.
    match do_start(&state, &app, &nodejs_bin_dir).await {
        Ok(port) => Ok(port),
        Err(e) => {
            set_status(&state, &app, OpenCodeStatus::Error(e.clone())).await;
            Err(e)
        }
    }
}

/// Inner startup logic extracted so that any `?` failure is caught by the
/// caller and translated into an `Error` status transition.
async fn do_start(
    state: &SharedOpenCodeState,
    app: &AppHandle,
    nodejs_bin_dir: &std::path::Path,
) -> Result<u16, String> {
    // Kill any stale processes from a previous crash/force-quit before
    // probing ports. This ensures find_available_port gets clean ports.
    cleanup_stale_processes();
    // Brief pause so the OS can release the TCP sockets after killing processes.
    tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;

    let port = find_available_port(OC_PORT_START).await;
    let mcp_port = find_available_port(MCP_PORT_START).await;
    let control_port = mcp_port.wrapping_add(10); // 59220+ range
    log::info!("OpenCode port: {port}, MCP bridge port: {mcp_port}, control port: {control_port}");

    {
        let mut s = state.lock().await;
        s.port = port;
        s.mcp_port = mcp_port;
    }

    // Configure the MCP server to use our bundled copy (run directly with node).
    // This avoids npx download issues on Windows and ensures a known-good version.
    let launcher_dir = crate::paths::bundled_launcher_dir().map_err(|e| {
        log::error!("Failed to find MCP launcher: {e}");
        e
    })?;
    let mcp_entry = launcher_dir.join("dist").join("launcher.js");
    log::info!("MCP launcher: {}", mcp_entry.display());

    #[cfg(unix)]
    let node_cmd = "node";
    #[cfg(windows)]
    let node_cmd = "node.exe";

    // On Windows, std::env::current_exe() runs fs::canonicalize which
    // prepends \\?\ to the path. We already strip this for PATH, but the
    // MCP entry path also needs it stripped — Node.js module resolution
    // can break when the entry script path has this prefix.
    #[cfg(unix)]
    let mcp_entry_str = mcp_entry.to_string_lossy().to_string();
    #[cfg(windows)]
    let mcp_entry_str = strip_win_prefix(&mcp_entry);

    // mcp_port and control_port are already set above from the reserved range.

    let mcp_config = serde_json::json!({
        "plugin": [
            "opencode-gemini-auth@latest"
        ],
        "mcp": {
            "roblox-studio": {
                "type": "local",
                "command": [node_cmd, &mcp_entry_str],
                "enabled": true,
                "environment": {
                    "ROBLOX_STUDIO_HOST": LOOPBACK,
                    "ROBLOX_STUDIO_PORT": mcp_port.to_string(),
                    "BLOXBOT_CONTROL_PORT": control_port.to_string()
                }
            }
        },
        "default_agent": "studio",
        "agent": {
            "build": {
                "description": "Executes tools based on the conversation"
            },
            "studio": {
                "mode": "primary",
                "description": "Roblox Studio development assistant",
                "prompt": concat!(
                    "You are BloxBot, an expert Roblox game developer working directly inside Roblox Studio. ",
                    "You have deep knowledge of the Roblox engine, the DataModel, Luau, and Studio workflows. ",
                    "You build games by using MCP tools to modify the live Studio session — not by showing code snippets.\n\n",

                    // ── Workflow ──────────────────────────────────────────
                    "## Workflow\n",
                    "1. **Explore first.** Before modifying anything, understand the project: `get_project_structure` (use maxDepth 5-10), `get_services`, `get_instance_children`, `get_selection`. Never guess at paths. Read existing scripts to understand conventions before writing new code.\n",
                    "2. **Make changes with tools.** Always use the MCP tools to create instances, set properties, write scripts, etc. directly in Studio. Never tell the user to paste code.\n",
                    "3. **Verify.** After changes, read back the result (`get_script_source`, `get_instance_properties`) to confirm correctness.\n",
                    "4. **Debug with playtests.** When behavior must be verified at runtime: instrument with print/warn, `start_playtest`, ask the user to perform actions, poll output with `get_playtest_output`, probe live state with `execute_luau`, `stop_playtest`, fix, repeat.\n\n",

                    // ── Project awareness ─────────────────────────────────
                    "## Project Awareness\n",
                    "At the start of a session or when you encounter an unfamiliar project, **scan the codebase** to learn its architecture. Use `get_project_structure` with high depth, then read key scripts. Identify:\n",
                    "- **Frameworks**: Knit, AeroGameFramework, Rojo project structure, Nevermore, Fusion, Roact/React-lua, Rodux, ProfileService/ProfileStore, DataStore2, etc. If the project uses one, all new code must follow its patterns (e.g. Knit Services/Controllers, Roact components, Fusion scopes).\n",
                    "- **Folder conventions**: How are scripts organized? Is there a Shared/ folder, a Systems/ folder, a Components/ folder? Place new code where it belongs.\n",
                    "- **Module patterns**: How does existing code structure ModuleScripts? (return table, OOP class via metatables, functional). Match the style.\n",
                    "- **Communication patterns**: Does the project use RemoteEvents directly, or wrap them (e.g. Knit, BridgeNet2, Red)? Use the same approach.\n",
                    "- **Naming conventions**: Do existing scripts use PascalCase, camelCase, or a prefix system? Does the project use specific naming for remotes, modules, etc.?\n\n",
                    "**Carry this context throughout the session.** Every script you write or edit must be consistent with the project's existing patterns. Do not introduce a new framework or architectural style unless the user explicitly asks for a refactor.\n\n",

                    // ── Tool guidance ─────────────────────────────────────
                    "## Tool Guide\n\n",

                    "**Scripts** — Always read first with `get_script_source` (returns numbered lines via `numberedSource`). ",
                    "For partial edits use `edit_script_lines`/`insert_script_lines`/`delete_script_lines` — they are safer and faster than rewriting the whole source. ",
                    "Only use `set_script_source` for new scripts or full rewrites. Line numbers are 1-indexed and inclusive.\n\n",

                    "**Instances** — Use `create_object_with_properties` to create and configure in one call. ",
                    "Use `mass_create_objects_with_properties` when creating multiple instances. ",
                    "Use `smart_duplicate` with positionOffset/propertyVariations for grids and arrays of objects.\n\n",

                    "**Properties** — `set_property` for single changes. `mass_set_property` for bulk. ",
                    "`set_relative_property` to offset from the current value (e.g. move +5 on Y). ",
                    "`set_calculated_property` for formula-driven values across multiple instances.\n\n",

                    "**Attributes & Tags** — Use attributes for custom data on instances (health, cost, team). ",
                    "Use CollectionService tags to group instances for system-level behavior (\"Lava\", \"Interactable\").\n\n",

                    "**Execute Luau** — `execute_luau` runs Luau in the plugin context with access to `game`, all services, and `print()`. ",
                    "Use it for complex queries, batch operations, or anything the focused tools don't cover.\n\n",

                    "**Playtest & Live Debugging** — `start_playtest` (mode: \"play\" or \"run\"), `get_playtest_output` to poll logs, `stop_playtest` to end. ",
                    "This is your debugger. Use it proactively when the user reports bugs or when you need to verify runtime behavior. ",
                    "Combine all three approaches for maximum effectiveness:\n",
                    "  1. **Instrumented logging** — Add strategic print/warn statements before the playtest to trace execution flow and variable state.\n",
                    "  2. **Live probing with `execute_luau`** — While the playtest is running, use `execute_luau` to inspect live game state: query property values, read attributes, check player positions, verify instance existence, evaluate conditions. This lets you diagnose issues without stopping the session.\n",
                    "  3. **User-directed actions** — Ask the user to perform specific in-game actions during the playtest (\"walk to the red part\", \"click the shop button\", \"try jumping on the platform\") then immediately poll output and probe state to observe the result. This is essential for testing interactions, UI flows, physics, and any player-triggered behavior.\n",
                    "The full debug loop: instrument code → start playtest → ask user to trigger the behavior → poll output + probe values with execute_luau → stop → analyze → fix → repeat.\n\n",

                    // ── Roblox architecture ───────────────────────────────
                    "## Roblox Architecture\n\n",

                    "**DataModel hierarchy**: game (DataModel) → Services → Instances. Key services and their roles:\n",
                    "- `Workspace` — 3D world. BaseParts, Models, Terrain, Camera live here. Replicated.\n",
                    "- `ServerScriptService` — Server Scripts. Never accessible from client.\n",
                    "- `ServerStorage` — Server-only assets, data templates. Not replicated to clients.\n",
                    "- `ReplicatedStorage` — Shared between server and client. ModuleScripts, RemoteEvents, RemoteFunctions, assets.\n",
                    "- `StarterPlayerScripts` / `StarterCharacterScripts` — LocalScripts cloned to each player.\n",
                    "- `StarterGui` — ScreenGuis/LocalScripts cloned to each player's PlayerGui.\n",
                    "- `Players` — Player objects (with Character models in Workspace).\n",
                    "- `Lighting` — Atmosphere, sky, time of day, post-processing.\n",
                    "- `SoundService` — Ambient and spatial audio.\n",
                    "- `TweenService`, `RunService`, `UserInputService`, `ContextActionService`, `CollectionService`, `PhysicsService`, `MarketplaceService`, `DataStoreService`, `MessagingService`, `HttpService` — use `:GetService()` to access.\n\n",

                    "**Client-server model**: Server is authoritative. Clients see a replicated subset. Communication via RemoteEvents (fire-and-forget) and RemoteFunctions (request-response) in ReplicatedStorage. ",
                    "**Never trust the client.** Validate all inputs server-side. Exploiters can fire any RemoteEvent with any arguments.\n\n",

                    "**Script types**:\n",
                    "- `Script` — runs on server (ServerScriptService, Workspace, or ServerStorage). Has `game:GetService()` access to all server APIs.\n",
                    "- `LocalScript` — runs on client (StarterPlayerScripts, StarterCharacterScripts, StarterGui). Has access to `LocalPlayer`, UserInputService, Camera.\n",
                    "- `ModuleScript` — shared code loaded via `require()`. Place in ReplicatedStorage (shared), ServerStorage (server-only), or alongside consumers.\n\n",

                    // ── Luau style ────────────────────────────────────────
                    "## Luau Style\n",
                    "- Write idiomatic **Luau**. Use type annotations, `if-then-else` expressions, string interpolation (`backtick syntax`), and typed `for` loops.\n",
                    "- **Descriptive names only.** `player` not `p`, `character` not `char`, `humanoid` not `hum`, `connection` not `conn`. Readability over brevity, always.\n",
                    "- PascalCase for services, instances, properties, methods. camelCase for local variables and functions.\n",
                    "- Use `:GetService()` to access services. Use `:WaitForChild()` on the client when referencing instances that may not have replicated yet.\n",
                    "- Handle cleanup: disconnect connections, destroy cloned instances, use `Maid`/`Trove` patterns or `task.cancel()` for spawned threads.\n",
                    "- Use `task.spawn`, `task.defer`, `task.delay`, `task.wait` (not legacy `spawn`, `wait`, `delay`).\n\n",

                    // ── Knowledge & docs ──────────────────────────────────
                    "## Roblox Knowledge\n",
                    "You have deep knowledge of the Roblox engine, but APIs evolve. ",
                    "When uncertain about a class, property, method, or enum — or when using less-common APIs — ",
                    "**search the Roblox documentation** (create.roblox.com/docs) or the DevForum (devforum.roblox.com) before writing code. ",
                    "Do not guess API signatures. Getting a method name or parameter wrong wastes the user's time.\n\n",

                    "Common reference points:\n",
                    "- Instance API: Instance.new(), :Clone(), :Destroy(), :FindFirstChild(), :FindFirstChildOfClass(), :GetChildren(), :GetDescendants(), :WaitForChild(), :SetAttribute(), :GetAttribute()\n",
                    "- Events: .Changed, :GetPropertyChangedSignal(), .ChildAdded, .ChildRemoved, .Touched, .PlayerAdded, .CharacterAdded\n",
                    "- Physics: BasePart.Anchored, AssemblyLinearVelocity, CollisionGroup, CustomPhysicalProperties\n",
                    "- UI: ScreenGui, Frame, TextLabel, TextButton, ImageLabel, UIListLayout, UIStroke, UICorner, UIGradient, UIPadding\n\n",

                    // ── Communication ─────────────────────────────────────
                    "## Communication\n",
                    "Be concise and practical. Show what you did, not how to do it — the tools already did it. ",
                    "Explain *why* you chose an approach when it's non-obvious. ",
                    "If a request is outside what the tools can do (e.g. publishing, Team Create, marketplace), say so clearly."
                )
            }
        }
    });
    let config_content = serde_json::to_string_pretty(&mcp_config)
        .map_err(|e| format!("Failed to serialize OpenCode config: {e}"))?;

    log::debug!("Config: {config_content}");

    let workspace = crate::paths::workspace_dir()?;

    // Create isolated XDG directories under ~/BloxBot/.opencode/
    // This prevents the bundled OpenCode from reading/writing to the user's
    // global ~/.config/opencode, ~/.local/share/opencode, etc.
    let opencode_home = workspace.join(".opencode");
    let xdg_data = opencode_home.join("data");
    let xdg_config = opencode_home.join("config");
    let xdg_cache = opencode_home.join("cache");
    let xdg_state = opencode_home.join("state");

    // Create directories if they don't exist
    for dir in [&xdg_data, &xdg_config, &xdg_cache, &xdg_state] {
        if !dir.exists() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("Failed to create directory {}: {e}", dir.display()))?;
        }
    }

    // Write the config file that OpenCode actually reads on startup.
    // OPENCODE_CONFIG_CONTENT env var is ignored — OpenCode loads from
    // {XDG_CONFIG_HOME}/opencode/opencode.json instead.
    let config_dir = xdg_config.join("opencode");
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;
    let config_file = config_dir.join("opencode.json");
    std::fs::write(&config_file, &config_content)
        .map_err(|e| format!("Failed to write OpenCode config: {e}"))?;
    log::info!("Wrote OpenCode config to {}", config_file.display());

    // Build a minimal PATH with our bundled Node.js bin directory first,
    // then essential system paths. This ensures npx/npm use our bundled Node.js.
    //
    // On Windows, Tauri resolves resource paths with the \\?\ extended-length prefix
    // (from std::fs::canonicalize). This prefix breaks PATH lookups and child process
    // resolution, so we strip it.
    let sidecar_dir = crate::paths::sidecar_dir()?;

    #[cfg(unix)]
    let nodejs_bin = nodejs_bin_dir.to_string_lossy().to_string();
    #[cfg(windows)]
    let nodejs_bin = strip_win_prefix(nodejs_bin_dir);

    #[cfg(unix)]
    let sidecar_path_str = sidecar_dir.to_string_lossy().to_string();
    #[cfg(windows)]
    let sidecar_path_str = strip_win_prefix(&sidecar_dir);

    #[cfg(unix)]
    let minimal_path = format!(
        "{}:{}:/usr/bin:/bin:/usr/sbin:/sbin",
        nodejs_bin, sidecar_path_str
    );
    #[cfg(windows)]
    let minimal_path = format!(
        "{};{};C:\\Windows\\System32;C:\\Windows",
        nodejs_bin, sidecar_path_str
    );

    // Spawn the sidecar via the shell plugin. This automatically resolves
    // the binary from the `externalBin` config in tauri.conf.json.
    let (rx, child) = app
        .shell()
        .sidecar("opencode")
        .map_err(|e| {
            let msg = format!("Failed to create sidecar command: {e}");
            log::error!("{msg}");
            msg
        })?
        .args([
            "serve",
            "--port",
            &port.to_string(),
            "--hostname",
            LOOPBACK,
            "--print-logs",
            "--log-level",
            "DEBUG",
        ])
        .current_dir(&workspace)
        // Isolated XDG directories
        .env("XDG_DATA_HOME", &xdg_data)
        .env("XDG_CONFIG_HOME", &xdg_config)
        .env("XDG_CACHE_HOME", &xdg_cache)
        .env("XDG_STATE_HOME", &xdg_state)
        // Minimal PATH with bundled node/npm/npx first
        .env("PATH", &minimal_path)
        .spawn()
        .map_err(|e| {
            let msg = format!("Failed to start OpenCode server: {e}");
            log::error!("{msg}");
            msg
        })?;

    log::info!("Isolated environment: {}", opencode_home.display());
    log::debug!("PATH: {}", minimal_path);

    {
        let mut s = state.lock().await;
        s.child = Some(child);
    }

    // Spawn an event handler for stdout, stderr, and process exit.
    // This replaces both the BufReader capture tasks and the polling-based
    // spawn_exit_monitor from the old tokio::process implementation.
    spawn_event_handler(rx, Arc::clone(state), app.clone());

    // Wait for the server to be ready by polling the health endpoint.
    // If the process exits (detected via the event handler setting the
    // status to Error), bail out immediately instead of waiting the full
    // timeout — this avoids a ~35 second hang when the binary crashes on
    // launch.
    let health_url = format!("http://{LOOPBACK}:{port}/global/health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let mut healthy = false;
    for _ in 0..15 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        // Check if the process already exited (the event handler sets
        // child to None and status to Error on termination).
        {
            let s = state.lock().await;
            if s.child.is_none() {
                // Process is gone — return whatever error the event
                // handler already set, or a generic message.
                if let OpenCodeStatus::Error(ref msg) = s.status {
                    let err = msg.clone();
                    log::error!("Process exited before becoming healthy: {err}");
                    return Err(err);
                }
                let err = "OpenCode process exited before becoming healthy".to_string();
                log::error!("{err}");
                drop(s);
                set_status(state, app, OpenCodeStatus::Error(err.clone())).await;
                return Err(err);
            }
        }

        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                healthy = true;
                break;
            }
        }
    }

    if healthy {
        log::info!("Server healthy on port {port}");
        set_status(state, app, OpenCodeStatus::Running).await;
        Ok(port)
    } else {
        // One final check: the process may have died on the last iteration.
        let s = state.lock().await;
        if let OpenCodeStatus::Error(ref msg) = s.status {
            let err = msg.clone();
            log::error!("Process exited during health check: {err}");
            return Err(err);
        }
        drop(s);

        let err = "OpenCode server started but health check timed out".to_string();
        log::error!("{err}");
        set_status(state, app, OpenCodeStatus::Error(err.clone())).await;
        Err(err)
    }
}

/// Spawn an event handler task that processes stdout/stderr and handles
/// process termination logging.
///
/// Runs on a dedicated OS thread with its own tokio runtime because the
/// shell plugin's `CommandEvent` receiver is not `Send`.
fn spawn_event_handler(
    rx: tauri::async_runtime::Receiver<CommandEvent>,
    state: SharedOpenCodeState,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to build tokio runtime for event handler: {e}");
                return;
            }
        };

        rt.block_on(async move {
            process_events(rx, &state, &app).await;
        });
    });
}

/// Sidecar stderr lines matching these substrings are high-frequency
/// noise (polling, per-request logs, bus events, tool registry chatter)
/// that add no diagnostic value at normal log levels.
const NOISY_PATTERNS: &[&str] = &[
    "path=/mcp request",
    "path=/global/health request",
    "service=server method=",
    "service=server status=",
    "service=bus type=",
    "service=tool.registry",
    "service=permission",
];

/// Parse the sidecar's own log level from its structured output.
/// Lines look like: `INFO  2026-02-12T... message` or `DEBUG ...`.
/// Returns the extracted level and the original line (for logging).
fn parse_sidecar_level(line: &str) -> log::Level {
    let trimmed = line.trim_start();
    if trimmed.starts_with("ERROR") {
        log::Level::Error
    } else if trimmed.starts_with("WARN") {
        log::Level::Warn
    } else if trimmed.starts_with("DEBUG") {
        log::Level::Debug
    } else if trimmed.starts_with("INFO") {
        log::Level::Info
    } else {
        // Unstructured line (e.g. stack trace, raw output) — default to warn
        log::Level::Warn
    }
}

/// Returns `true` if the line is high-frequency noise that should be
/// suppressed at normal verbosity.
fn is_noisy_sidecar_line(line: &str) -> bool {
    NOISY_PATTERNS.iter().any(|p| line.contains(p))
}

/// Process shell plugin events until the process terminates.
async fn process_events(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    state: &SharedOpenCodeState,
    app: &AppHandle,
) {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim_end();
                if is_noisy_sidecar_line(trimmed) {
                    log::trace!(target: "opencode::stdout", "{trimmed}");
                } else {
                    log::info!(target: "opencode::stdout", "{trimmed}");
                }
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                let trimmed = text.trim_end();
                if trimmed.is_empty() {
                    continue;
                }
                if is_noisy_sidecar_line(trimmed) {
                    log::trace!(target: "opencode::stderr", "{trimmed}");
                } else {
                    match parse_sidecar_level(trimmed) {
                        log::Level::Error => log::error!(target: "opencode::stderr", "{trimmed}"),
                        log::Level::Warn => log::warn!(target: "opencode::stderr", "{trimmed}"),
                        log::Level::Info => log::info!(target: "opencode::stderr", "{trimmed}"),
                        log::Level::Debug => log::debug!(target: "opencode::stderr", "{trimmed}"),
                        _ => log::debug!(target: "opencode::stderr", "{trimmed}"),
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                handle_process_exit(state, app, &payload).await;
                return;
            }
            _ => {}
        }
    }
}

/// Handle process termination. Sets the appropriate status so the
/// frontend can show an error with a manual retry button.
async fn handle_process_exit(
    state: &SharedOpenCodeState,
    app: &AppHandle,
    payload: &tauri_plugin_shell::process::TerminatedPayload,
) {
    let mut s = state.lock().await;
    s.child = None;

    if payload.code == Some(0) {
        log::info!("Process exited cleanly");
        s.status = OpenCodeStatus::Stopped;
        emit_status(app, &s.status, s.port);
        return;
    }

    let raw_msg = format!(
        "Exited with code {:?} (signal {:?})",
        payload.code, payload.signal
    );
    log::warn!("Process exited: {raw_msg}");

    // Present a human-friendly message to the user; the raw details
    // are already in the log for debugging.
    let user_msg = match payload.code {
        Some(code) => format!("The server exited unexpectedly (code {code})."),
        None => match payload.signal {
            Some(sig) => format!("The server was terminated by signal {sig}."),
            None => "The server stopped unexpectedly.".to_string(),
        },
    };
    s.status = OpenCodeStatus::Error(user_msg);
    emit_status(app, &s.status, s.port);
}

/// Gracefully stop everything: MCP server (via launcher control endpoint),
/// then the OpenCode sidecar. Waits briefly between the MCP shutdown
/// request and killing the sidecar so the launcher has time to terminate
/// its child process tree.
pub async fn stop_all(state: &SharedOpenCodeState, app: &AppHandle) {
    let (mcp_port, has_child) = {
        let s = state.lock().await;
        (s.mcp_port, s.child.is_some())
    };

    if !has_child && mcp_port == 0 {
        return;
    }

    // Step 1: Ask the launcher to gracefully shut down the MCP server.
    if mcp_port > 0 {
        shutdown_mcp_server(mcp_port).await;
        // Give the launcher time to SIGTERM the child and exit (it waits
        // up to 2s internally before SIGKILL). 1.5s is enough in the
        // happy path; the sidecar kill below is the final backstop.
        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;
    }

    // Step 2: Kill the OpenCode sidecar process.
    let mut s = state.lock().await;
    if let Some(child) = s.child.take() {
        let _ = child.kill();
    }
    s.status = OpenCodeStatus::Stopped;
    s.port = 0;
    s.mcp_port = 0;
    emit_status(app, &s.status, 0);
}

// ── Tauri commands ──────────────────────────────────────────────────────

/// Get the current OpenCode server status. Used for the initial status
/// check when the frontend first loads (in case it missed earlier events).
#[tauri::command]
pub async fn get_opencode_status(
    state: tauri::State<'_, SharedOpenCodeState>,
) -> Result<(OpenCodeStatus, u16), String> {
    let s = state.lock().await;
    Ok((s.status.clone(), s.port))
}

/// Restart the OpenCode server. Gracefully tears down all processes
/// (MCP + sidecar) then starts fresh. Called from the frontend retry button.
#[tauri::command]
pub async fn restart_opencode(
    state: tauri::State<'_, SharedOpenCodeState>,
    app: AppHandle,
) -> Result<u16, String> {
    // Stop everything first (no-op if already stopped)
    stop_all(state.inner(), &app).await;
    // Clean up any orphans that survived
    cleanup_stale_processes();
    // Small delay for ports to be released by the OS
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    // Start fresh
    start_opencode_server(state.inner().clone(), app).await
}

/// Combined studio status poll.  Queries both the OpenCode server (for
/// MCP server state) and the MCP bridge health endpoint (for Studio
/// plugin connectivity) in a single Tauri command, avoiding CORS issues.
#[tauri::command]
pub async fn poll_studio_status(
    state: tauri::State<'_, SharedOpenCodeState>,
) -> Result<StudioStatusResult, String> {
    let (oc_port, mcp_port) = {
        let s = state.lock().await;
        // If OpenCode isn't running yet there's nothing to poll.
        if !matches!(s.status, OpenCodeStatus::Running) {
            return Ok(StudioStatusResult {
                status: "unknown".into(),
                error: None,
            });
        }
        (s.port, s.mcp_port)
    };
    let workspace = crate::paths::workspace_dir()?;
    let client = http_client();

    // ── Step 1: ask OpenCode for the MCP server status ─────────────
    let workspace_str = workspace.to_string_lossy().to_string();
    let mcp_url = format!("http://{LOOPBACK}:{oc_port}/mcp");
    let mut mcp_connected = false;

    match client
        .get(&mcp_url)
        .header("x-opencode-directory", &workspace_str)
        .query(&[("directory", &workspace_str)])
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                log::trace!("OpenCode /mcp response: {body}");
                if let Some(rs) = body.get("roblox-studio") {
                    let status_str = rs
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");

                    match status_str {
                        "failed" => {
                            let err = rs.get("error").and_then(|v| v.as_str()).map(String::from);
                            return Ok(StudioStatusResult {
                                status: "failed".into(),
                                error: err,
                            });
                        }
                        "disabled" => {
                            return Ok(StudioStatusResult {
                                status: "disabled".into(),
                                error: None,
                            });
                        }
                        "needs_auth" | "needs_client_registration" => {
                            return Ok(StudioStatusResult {
                                status: "needs_auth".into(),
                                error: None,
                            });
                        }
                        "connected" => {
                            mcp_connected = true;
                        }
                        other => {
                            log::warn!("Unknown MCP status: {other}");
                        }
                    }
                } else {
                    log::debug!("No 'roblox-studio' key in /mcp response");
                }
            }
        }
        Ok(resp) => {
            log::warn!("OpenCode /mcp returned HTTP {}", resp.status());
        }
        Err(e) => {
            log::warn!("OpenCode /mcp request failed: {e}");
        }
    }

    // Only check the health endpoint if OpenCode reports MCP as connected.
    // Otherwise there's no point — the MCP server isn't running.
    if !mcp_connected {
        return Ok(StudioStatusResult {
            status: "unknown".into(),
            error: None,
        });
    }

    // ── Step 2: poll the MCP bridge health endpoint ────────────────
    let health_url = format!("http://{LOOPBACK}:{mcp_port}/health");
    log::trace!("Checking MCP health at {health_url}");
    match client.get(&health_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or(serde_json::Value::Null);
            log::trace!("MCP health response: {body}");
            let plugin_connected = body
                .get("pluginConnected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            Ok(StudioStatusResult {
                status: if plugin_connected {
                    "connected"
                } else {
                    "disconnected"
                }
                .into(),
                error: None,
            })
        }
        Ok(resp) => {
            let status = resp.status();
            log::warn!("MCP health returned HTTP {status}");
            Ok(StudioStatusResult {
                status: "failed".into(),
                error: Some(format!("HTTP {status}")),
            })
        }
        Err(e) => {
            log::warn!("MCP health request failed: {e}");
            Ok(StudioStatusResult {
                status: "failed".into(),
                error: None,
            })
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StudioStatusResult {
    pub status: String,
    pub error: Option<String>,
}

/// Gracefully shut down the MCP server via the launcher's control endpoint.
/// Called on app quit and before MCP restart to ensure clean process cleanup.
pub async fn shutdown_mcp_server(mcp_port: u16) {
    let control_port = mcp_port.wrapping_add(10);
    let url = format!("http://{LOOPBACK}:{control_port}/shutdown");

    match http_client().post(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            log::info!("MCP server shutdown requested via control port {control_port}");
        }
        Ok(resp) => {
            log::warn!("MCP shutdown returned HTTP {}", resp.status());
        }
        Err(e) => {
            // Launcher may not be running — that's fine
            log::debug!("MCP shutdown request failed (may not be running): {e}");
        }
    }
}

/// Tauri command wrapper for shutdown_mcp_server.
#[tauri::command]
pub async fn shutdown_mcp(state: tauri::State<'_, SharedOpenCodeState>) -> Result<(), String> {
    let mcp_port = state.lock().await.mcp_port;
    shutdown_mcp_server(mcp_port).await;
    Ok(())
}

/// Return the auto-picked MCP bridge URL for the Studio plugin to connect to.
#[tauri::command]
pub async fn get_mcp_url(
    state: tauri::State<'_, SharedOpenCodeState>,
) -> Result<String, String> {
    let mcp_port = state.lock().await.mcp_port;
    if mcp_port == 0 {
        return Err("MCP server not started yet".into());
    }
    Ok(format!("http://{LOOPBACK}:{mcp_port}"))
}
