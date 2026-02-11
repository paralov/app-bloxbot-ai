//! OpenCode server management.
//!
//! Starts the OpenCode server as a child process on app launch and emits
//! Tauri events when its status changes. The frontend never polls -- it
//! just listens for `opencode-status-changed` events.
//!
//! All process spawning goes through `tauri-plugin-shell`, which provides
//! sidecar resolution, event-based stdout/stderr, and cross-platform
//! process management (including hiding console windows on Windows).

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

/// Preferred starting port for the OpenCode server.
const DEFAULT_PORT: u16 = 4096;

/// How many consecutive ports to try before giving up.
const PORT_RANGE: u16 = 10;

/// Default port for the MCP bridge (Studio plugin ↔ MCP server).
const MCP_PORT: u16 = 3002;

/// Delay before auto-restart after a crash.
const RESTART_DELAY_SECS: u64 = 3;

/// Maximum number of consecutive auto-restart attempts.
const MAX_RESTART_ATTEMPTS: u32 = 5;

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
    pub(crate) child: Option<CommandChild>,
    /// Consecutive restart attempts (reset on successful health check).
    restart_attempts: u32,
}

impl Default for OpenCodeState {
    fn default() -> Self {
        Self {
            status: OpenCodeStatus::Stopped,
            port: DEFAULT_PORT,
            child: None,
            restart_attempts: 0,
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
async fn set_status(
    state: &SharedOpenCodeState,
    app: &AppHandle,
    status: OpenCodeStatus,
) {
    let port;
    {
        let mut s = state.lock().await;
        s.status = status.clone();
        port = s.port;
    }
    emit_status(app, &status, port);
}

/// Kill any stale `opencode serve` processes left over from previous runs.
async fn kill_stale_opencode_processes(app: &AppHandle) {
    #[cfg(unix)]
    {
        let cmd = app
            .shell()
            .command("pkill")
            .args(["-f", "opencode serve"]);
        match cmd.status().await {
            Ok(status) if status.success() => {
                log::info!("Killed stale opencode process(es)");
            }
            _ => {} // No stale processes or pkill not found — fine
        }
    }
    #[cfg(windows)]
    {
        let cmd = app
            .shell()
            .command("taskkill")
            .args(["/F", "/IM", "opencode.exe"]);
        match cmd.status().await {
            Ok(status) if status.success() => {
                log::info!("Killed stale opencode process(es)");
            }
            _ => {}
        }
    }
    // Brief pause so the OS can release bound ports.
    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
}

/// Find the first available TCP port starting from `start`.
async fn find_available_port(start: u16) -> u16 {
    for port in start..start.saturating_add(PORT_RANGE) {
        if tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return port;
        }
    }
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

    let nodejs_bin_dir = crate::paths::bundled_nodejs_bin_dir().map_err(|e| {
        log::error!("Failed to find Node.js: {e}");
        e
    })?;
    log::info!("Node.js bin: {}", nodejs_bin_dir.display());

    set_status(&state, &app, OpenCodeStatus::Starting).await;

    // Clean up stale processes, then find a free port.
    kill_stale_opencode_processes(&app).await;
    let port = find_available_port(DEFAULT_PORT).await;
    log::info!("Using port {port}");

    {
        let mut s = state.lock().await;
        s.port = port;
    }

    // Configure the MCP server to use our bundled copy (run directly with node).
    // This avoids npx download issues on Windows and ensures a known-good version.
    let mcp_server_dir = crate::paths::bundled_mcp_server_dir().map_err(|e| {
        log::error!("Failed to find MCP server: {e}");
        e
    })?;
    let mcp_entry = mcp_server_dir.join("dist").join("index.js");
    log::info!("MCP server: {}", mcp_entry.display());

    #[cfg(unix)]
    let node_cmd = "node";
    #[cfg(windows)]
    let node_cmd = "node.exe";

    let mcp_config = serde_json::json!({
        "plugin": [
            "opencode-gemini-auth@latest"
        ],
        "mcp": {
            "roblox-studio": {
                "type": "local",
                "command": [node_cmd, mcp_entry.to_string_lossy()],
                "enabled": true,
                "env": {
                    "ROBLOX_STUDIO_PORT": MCP_PORT.to_string()
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
                    "You are BloxBot, a specialized AI assistant for Roblox game development inside Roblox Studio.\n\n",
                    "## Your Capabilities\n",
                    "You have access to Roblox Studio through MCP (Model Context Protocol) tools. ",
                    "Use these tools to directly interact with the Studio environment: read and modify the explorer hierarchy, ",
                    "create and edit scripts, manipulate parts and models, manage properties, and more.\n\n",
                    "## Roblox Development Guidelines\n",
                    "- Write all game scripts in **Luau** (Roblox's typed Lua dialect). Use modern Luau features like type annotations, `if-then-else` expressions, and string interpolation where appropriate.\n",
                    "- Follow Roblox conventions: use PascalCase for services, instances, and properties. Use camelCase for local variables and functions.\n",
                    "- Distinguish between **Script** (server-side, runs in ServerScriptService or Workspace), **LocalScript** (client-side, runs in StarterPlayerScripts, StarterCharacterScripts, or StarterGui), and **ModuleScript** (shared code in ReplicatedStorage or ServerStorage).\n",
                    "- Use the correct Roblox services: Players, Workspace, ReplicatedStorage, ServerStorage, ServerScriptService, StarterGui, StarterPlayerScripts, Lighting, TweenService, UserInputService, RunService, etc.\n",
                    "- For client-server communication, use RemoteEvents and RemoteFunctions placed in ReplicatedStorage.\n",
                    "- Never trust the client. Validate all inputs on the server.\n\n",
                    "## MCP Tool Usage\n",
                    "Always prefer using the available Roblox Studio MCP tools to directly modify the Studio project rather than just showing code snippets. ",
                    "When a user asks you to create or modify something, use the tools to actually make the changes in Studio.\n",
                    "After making changes, briefly explain what you did and why.\n\n",
                    "## Communication Style\n",
                    "- Be concise and practical. Focus on making things work in Studio.\n",
                    "- When explaining Roblox concepts, be clear but don't over-explain basics unless asked.\n",
                    "- If something cannot be done through the available tools, explain what the user needs to do manually."
                )
            }
        }
    });
    let config_content = serde_json::to_string(&mcp_config)
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
    let nodejs_bin = strip_win_prefix(&nodejs_bin_dir);

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
        .args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"])
        .current_dir(&workspace)
        // Isolated XDG directories
        .env("XDG_DATA_HOME", &xdg_data)
        .env("XDG_CONFIG_HOME", &xdg_config)
        .env("XDG_CACHE_HOME", &xdg_cache)
        .env("XDG_STATE_HOME", &xdg_state)
        // Config content (MCP servers, plugins)
        .env("OPENCODE_CONFIG_CONTENT", &config_content)
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
    spawn_event_handler(rx, Arc::clone(&state), app.clone());

    // Wait for the server to be ready by polling the health endpoint
    let health_url = format!("http://127.0.0.1:{port}/global/health");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();

    let mut healthy = false;
    for _ in 0..15 {
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        if let Ok(resp) = client.get(&health_url).send().await {
            if resp.status().is_success() {
                healthy = true;
                break;
            }
        }
    }

    if healthy {
        {
            let mut s = state.lock().await;
            s.restart_attempts = 0;
        }
        log::info!("Server healthy on port {port}");
        set_status(&state, &app, OpenCodeStatus::Running).await;
        Ok(port)
    } else {
        let err = "OpenCode server started but health check timed out".to_string();
        log::error!("{err}");
        set_status(&state, &app, OpenCodeStatus::Error(err.clone())).await;
        Err(err)
    }
}

/// Spawn an event handler task that processes stdout/stderr and handles
/// process termination with auto-restart.
///
/// The restart loop lives inside this function so the recursive
/// `start_opencode_server` call doesn't need to be captured in a
/// `Send` future (the shell plugin's `Command` isn't `Send`).
fn spawn_event_handler(
    rx: tauri::async_runtime::Receiver<CommandEvent>,
    state: SharedOpenCodeState,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to build tokio runtime for event handler");

        rt.block_on(async move {
            let should_restart = process_events(rx, &state, &app).await;
            if should_restart {
                tokio::time::sleep(tokio::time::Duration::from_secs(RESTART_DELAY_SECS)).await;
                let _ = start_opencode_server(Arc::clone(&state), app).await;
            }
        });
    });
}

/// Process shell plugin events until the process terminates.
/// Returns `true` if the process should be auto-restarted.
async fn process_events(
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
    state: &SharedOpenCodeState,
    app: &AppHandle,
) -> bool {
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let text = String::from_utf8_lossy(&line);
                log::info!(target: "opencode::stdout", "{}", text.trim_end());
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                log::warn!(target: "opencode::stderr", "{}", text.trim_end());
            }
            CommandEvent::Terminated(payload) => {
                return handle_process_exit(state, app, &payload).await;
            }
            _ => {}
        }
    }
    false
}

/// Handle process termination from the shell plugin event channel.
/// Auto-restarts if the process crashed unexpectedly and we haven't
/// exceeded the restart limit.
///
/// Returns `true` if a restart should be attempted.
async fn handle_process_exit(
    state: &SharedOpenCodeState,
    app: &AppHandle,
    payload: &tauri_plugin_shell::process::TerminatedPayload,
) -> bool {
    let mut s = state.lock().await;
    s.child = None;
    let was_running = matches!(s.status, OpenCodeStatus::Running);

    if payload.code == Some(0) {
        log::info!("Process exited cleanly");
        s.status = OpenCodeStatus::Stopped;
        emit_status(app, &s.status, s.port);
        return false;
    }

    let msg = format!(
        "Exited with code {:?} (signal {:?})",
        payload.code, payload.signal
    );
    log::warn!("Process exited: {msg}");

    if was_running && s.restart_attempts < MAX_RESTART_ATTEMPTS {
        s.restart_attempts += 1;
        let attempt = s.restart_attempts;
        let port = s.port;
        drop(s);

        log::info!(
            "Auto-restart attempt {attempt}/{MAX_RESTART_ATTEMPTS} in {RESTART_DELAY_SECS}s"
        );
        emit_status(app, &OpenCodeStatus::Error(msg), port);
        true
    } else {
        s.status = OpenCodeStatus::Error(msg.clone());
        emit_status(app, &s.status, s.port);
        false
    }
}

/// Stop the OpenCode server. Currently only used at window destroy
/// (which kills the child directly), but kept for potential future use.
#[allow(dead_code)]
pub async fn stop_opencode_server(
    state: SharedOpenCodeState,
    app: &AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(child) = s.child.take() {
        child
            .kill()
            .map_err(|e| format!("Failed to kill OpenCode process: {e}"))?;
        s.status = OpenCodeStatus::Stopped;
        emit_status(app, &s.status, s.port);
        Ok(())
    } else {
        Ok(()) // Already stopped
    }
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

/// Kill any stale `robloxstudio-mcp` processes. Called by the frontend
/// when it detects the MCP stdio connection has broken but the HTTP
/// server on port 3002 is still alive (zombie process).
#[tauri::command]
pub async fn kill_stale_mcp(app: AppHandle) -> Result<(), String> {
    log::info!("Killing stale robloxstudio-mcp processes");

    #[cfg(unix)]
    {
        let _ = app
            .shell()
            .command("pkill")
            .args(["-f", "robloxstudio-mcp"])
            .status()
            .await;
    }
    #[cfg(windows)]
    {
        let _ = app
            .shell()
            .command("taskkill")
            .args([
                "/F",
                "/FI",
                "IMAGENAME eq bun.exe",
                "/FI",
                "COMMANDLINE eq *robloxstudio-mcp*",
            ])
            .status()
            .await;
    }

    // Wait for the MCP port to be released
    for _ in 0..10 {
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        if tokio::net::TcpListener::bind(("127.0.0.1", MCP_PORT))
            .await
            .is_ok()
        {
            log::info!("Port {} released", MCP_PORT);
            return Ok(());
        }
    }

    log::warn!("Port {} may still be in use", MCP_PORT);
    Ok(())
}
