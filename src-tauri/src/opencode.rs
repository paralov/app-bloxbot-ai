//! OpenCode server management.
//!
//! Starts the OpenCode server as a child process on app launch and emits
//! Tauri events when its status changes. The frontend never polls -- it
//! just listens for `opencode-status-changed` events.

use std::collections::VecDeque;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Windows: prevent child processes from opening a visible console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Preferred starting port for the OpenCode server.
const DEFAULT_PORT: u16 = 4096;

/// How many consecutive ports to try before giving up.
const PORT_RANGE: u16 = 10;

/// The robloxstudio-mcp package to run via bunx.
const MCP_PACKAGE: &str = "robloxstudio-mcp@latest";

/// Delay before auto-restart after a crash.
const RESTART_DELAY_SECS: u64 = 3;

/// Maximum number of consecutive auto-restart attempts.
const MAX_RESTART_ATTEMPTS: u32 = 5;

/// Maximum log entries kept in the ring buffer.
const MAX_LOG_ENTRIES: usize = 2000;

// ── Log infrastructure ──────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    pub timestamp: f64,
    pub source: String,
    pub message: String,
}

/// Shared ring buffer of log entries, accessible from anywhere.
pub type SharedLogBuffer = Arc<Mutex<VecDeque<LogEntry>>>;

/// Append a log line to the buffer and emit it as a Tauri event.
pub fn app_log(buffer: &SharedLogBuffer, app: &AppHandle, source: &str, message: &str) {
    let entry = LogEntry {
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
        source: source.to_string(),
        message: message.to_string(),
    };

    // Also print to stderr for dev mode
    eprintln!("[{}] {}", source, message);

    let _ = app.emit("app-log", &entry);

    // Non-blocking push to ring buffer (try_lock to avoid blocking the caller)
    let buf = buffer.clone();
    let entry_clone = entry;
    tokio::spawn(async move {
        let mut b = buf.lock().await;
        if b.len() >= MAX_LOG_ENTRIES {
            b.pop_front();
        }
        b.push_back(entry_clone);
    });
}

/// Helper for synchronous contexts (blocking push).
pub fn app_log_sync(buffer: &SharedLogBuffer, app: &AppHandle, source: &str, message: &str) {
    let entry = LogEntry {
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64(),
        source: source.to_string(),
        message: message.to_string(),
    };

    eprintln!("[{}] {}", source, message);
    let _ = app.emit("app-log", &entry);

    // Best-effort push (try_lock to avoid deadlock in sync context)
    if let Ok(mut b) = buffer.try_lock() {
        if b.len() >= MAX_LOG_ENTRIES {
            b.pop_front();
        }
        b.push_back(entry);
    }
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
    pub(crate) child: Option<Child>,
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
async fn kill_stale_opencode_processes(log: &SharedLogBuffer, app: &AppHandle) {
    #[cfg(unix)]
    {
        let output = Command::new("pkill")
            .args(["-f", "opencode serve"])
            .output()
            .await;
        if let Ok(o) = output {
            if o.status.success() {
                app_log(log, app, "opencode", "Killed stale opencode process(es)");
            }
        }
    }
    #[cfg(windows)]
    {
        let output = Command::new("taskkill")
            .args(["/F", "/IM", "opencode.exe"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await;
        if let Ok(o) = output {
            if o.status.success() {
                app_log(log, app, "opencode", "Killed stale opencode process(es)");
            }
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
/// Emits `opencode-status-changed` events as the server progresses
/// through Starting -> Running (or Error).
pub async fn start_opencode_server(
    state: SharedOpenCodeState,
    app: AppHandle,
    log: SharedLogBuffer,
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

    let opencode_bin = crate::paths::bundled_opencode_path().map_err(|e| {
        app_log(&log, &app, "opencode", &format!("Failed to find opencode binary: {e}"));
        e
    })?;
    app_log(&log, &app, "opencode", &format!("Binary: {}", opencode_bin.display()));

    let nodejs_bin_dir = crate::paths::bundled_nodejs_bin_dir().map_err(|e| {
        app_log(&log, &app, "opencode", &format!("Failed to find Node.js: {e}"));
        e
    })?;
    app_log(&log, &app, "opencode", &format!("Node.js bin: {}", nodejs_bin_dir.display()));

    set_status(&state, &app, OpenCodeStatus::Starting).await;

    // Clean up stale processes, then find a free port.
    kill_stale_opencode_processes(&log, &app).await;
    let port = find_available_port(DEFAULT_PORT).await;
    app_log(&log, &app, "opencode", &format!("Using port {port}"));

    {
        let mut s = state.lock().await;
        s.port = port;
    }

    // Configure the MCP server for robloxstudio-mcp.
    // npx from our bundled Node.js will fetch and run the package.
    // On Windows, npx is a .cmd batch wrapper so we must use npx.cmd.
    #[cfg(unix)]
    let npx_cmd = "npx";
    #[cfg(windows)]
    let npx_cmd = "npx.cmd";

    let mcp_config = serde_json::json!({
        "plugin": [
            "opencode-gemini-auth@latest"
        ],
        "mcp": {
            "roblox-studio": {
                "type": "local",
                "command": [npx_cmd, MCP_PACKAGE],
                "enabled": true
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

    app_log(&log, &app, "opencode", &format!("Config: {config_content}"));

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
    #[cfg(unix)]
    let nodejs_bin = nodejs_bin_dir.to_string_lossy().to_string();
    #[cfg(windows)]
    let nodejs_bin = strip_win_prefix(&nodejs_bin_dir);

    #[cfg(unix)]
    let sidecar_dir = opencode_bin
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    #[cfg(windows)]
    let sidecar_dir = opencode_bin
        .parent()
        .map(|p| strip_win_prefix(p))
        .unwrap_or_default();

    #[cfg(unix)]
    let minimal_path = format!("{}:{}:/usr/bin:/bin:/usr/sbin:/sbin", nodejs_bin, sidecar_dir);
    #[cfg(windows)]
    let minimal_path = format!(
        "{};{};C:\\Windows\\System32;C:\\Windows",
        nodejs_bin, sidecar_dir
    );

    let mut cmd = Command::new(&opencode_bin);
    cmd.arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--hostname")
        .arg("127.0.0.1")
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // On Windows, prevent the child process from spawning a visible console window
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("Failed to start OpenCode server: {e}");
        app_log(&log, &app, "opencode", &msg);
        msg
    })?;

    app_log(&log, &app, "opencode", &format!("Isolated environment: {}", opencode_home.display()));
    app_log(&log, &app, "opencode", &format!("PATH: {}", minimal_path));

    // Capture stderr for logging (all lines)
    if let Some(stderr) = child.stderr.take() {
        let log2 = log.clone();
        let app2 = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                app_log(&log2, &app2, "opencode:err", &line);
            }
        });
    }

    // Capture stdout for logging
    if let Some(stdout) = child.stdout.take() {
        let log2 = log.clone();
        let app2 = app.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                app_log(&log2, &app2, "opencode:out", &line);
            }
        });
    }

    {
        let mut s = state.lock().await;
        s.child = Some(child);
    }

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
        app_log(&log, &app, "opencode", &format!("Server healthy on port {port}"));
        set_status(&state, &app, OpenCodeStatus::Running).await;

        // Spawn the process exit monitor with auto-restart
        spawn_exit_monitor(Arc::clone(&state), app.clone(), log);

        Ok(port)
    } else {
        let err = "OpenCode server started but health check timed out".to_string();
        app_log(&log, &app, "opencode", &err);
        set_status(&state, &app, OpenCodeStatus::Error(err.clone())).await;
        Err(err)
    }
}

/// Monitor the child process. If it exits unexpectedly, update status
/// and attempt auto-restart (up to MAX_RESTART_ATTEMPTS).
fn spawn_exit_monitor(state: SharedOpenCodeState, app: AppHandle, log: SharedLogBuffer) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
            let mut s = state.lock().await;
            if let Some(ref mut child) = s.child {
                match child.try_wait() {
                    Ok(Some(exit_status)) => {
                        s.child = None;
                        let was_running =
                            matches!(s.status, OpenCodeStatus::Running);

                        if exit_status.success() {
                            app_log(&log, &app, "opencode", "Process exited cleanly");
                            s.status = OpenCodeStatus::Stopped;
                            emit_status(&app, &s.status, s.port);
                        } else {
                            let msg = format!("Exited with {exit_status}");
                            app_log(&log, &app, "opencode", &format!("Process exited: {msg}"));

                            // Auto-restart if we were previously running
                            // and haven't exceeded the attempt limit
                            if was_running
                                && s.restart_attempts < MAX_RESTART_ATTEMPTS
                            {
                                s.restart_attempts += 1;
                                let attempt = s.restart_attempts;
                                let port = s.port;
                                drop(s); // release lock before restart

                                app_log(&log, &app, "opencode", &format!(
                                    "Auto-restart attempt {attempt}/{MAX_RESTART_ATTEMPTS} in {RESTART_DELAY_SECS}s"
                                ));
                                emit_status(
                                    &app,
                                    &OpenCodeStatus::Error(msg),
                                    port,
                                );

                                tokio::time::sleep(
                                    tokio::time::Duration::from_secs(RESTART_DELAY_SECS),
                                )
                                .await;

                                let _ = start_opencode_server(
                                    Arc::clone(&state),
                                    app.clone(),
                                    log.clone(),
                                )
                                .await;
                                return; // new monitor spawned by start_opencode_server
                            } else {
                                s.status = OpenCodeStatus::Error(msg.clone());
                                emit_status(&app, &s.status, s.port);
                            }
                        }
                        break;
                    }
                    Ok(None) => {} // Still running
                    Err(e) => {
                        app_log(&log, &app, "opencode", &format!("Exit monitor error: {e}"));
                        s.status = OpenCodeStatus::Error(e.to_string());
                        s.child = None;
                        emit_status(&app, &s.status, s.port);
                        break;
                    }
                }
            } else {
                break;
            }
        }
    });
}

/// Stop the OpenCode server. Currently only used at window destroy
/// (which kills the child directly), but kept for potential future use.
#[allow(dead_code)]
pub async fn stop_opencode_server(
    state: SharedOpenCodeState,
    app: &AppHandle,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(ref mut child) = s.child {
        child
            .kill()
            .await
            .map_err(|e| format!("Failed to kill OpenCode process: {e}"))?;
        s.status = OpenCodeStatus::Stopped;
        s.child = None;
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
pub async fn kill_stale_mcp(
    log: tauri::State<'_, SharedLogBuffer>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    app_log(&log, &app, "mcp", "Killing stale robloxstudio-mcp processes");

    #[cfg(unix)]
    {
        let _ = Command::new("pkill")
            .args(["-f", "robloxstudio-mcp"])
            .output()
            .await;
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/FI", "IMAGENAME eq bun.exe", "/FI", "COMMANDLINE eq *robloxstudio-mcp*"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await;
    }

    // Wait for port 3002 to be released
    for _ in 0..10 {
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        if tokio::net::TcpListener::bind(("127.0.0.1", 3002))
            .await
            .is_ok()
        {
            app_log(&log, &app, "mcp", "Port 3002 released");
            return Ok(());
        }
    }

    app_log(&log, &app, "mcp", "Warning: port 3002 may still be in use");
    Ok(())
}

/// Retrieve all buffered log entries. Used by the frontend debug panel
/// to show logs that were emitted before the panel was opened.
#[tauri::command]
pub async fn get_logs(
    log: tauri::State<'_, SharedLogBuffer>,
) -> Result<Vec<LogEntry>, String> {
    let b = log.lock().await;
    Ok(b.iter().cloned().collect())
}
