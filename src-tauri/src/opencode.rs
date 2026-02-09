//! OpenCode server management.
//!
//! Starts the OpenCode server as a child process on app launch and emits
//! Tauri events when its status changes. The frontend never polls -- it
//! just listens for `opencode-status-changed` events.

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

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
async fn kill_stale_opencode_processes() {
    #[cfg(unix)]
    {
        let output = Command::new("pkill")
            .args(["-f", "opencode serve"])
            .output()
            .await;
        if let Ok(o) = output {
            if o.status.success() {
                eprintln!("[opencode] Killed stale opencode process(es)");
            }
        }
    }
    #[cfg(windows)]
    {
        let output = Command::new("taskkill")
            .args(["/F", "/IM", "opencode.exe"])
            .output()
            .await;
        if let Ok(o) = output {
            if o.status.success() {
                eprintln!("[opencode] Killed stale opencode process(es)");
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

// ── Core lifecycle ──────────────────────────────────────────────────────

/// Start the OpenCode server. Called automatically on app launch.
///
/// Emits `opencode-status-changed` events as the server progresses
/// through Starting -> Running (or Error).
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

    let opencode_bin = crate::paths::bundled_opencode_path()?;
    let bun_path = crate::paths::bundled_bun_path()?;

    set_status(&state, &app, OpenCodeStatus::Starting).await;

    // Clean up stale processes, then find a free port.
    kill_stale_opencode_processes().await;
    let port = find_available_port(DEFAULT_PORT).await;
    eprintln!("[opencode] Using port {port}");

    {
        let mut s = state.lock().await;
        s.port = port;
    }

    // Configure the MCP server for robloxstudio-mcp using the bundled Bun,
    // and register auth plugins so providers like Google get OAuth support.
    let bun_str = bun_path.to_string_lossy().to_string();
    let mcp_config = serde_json::json!({
        "plugin": [
            "opencode-gemini-auth@latest"
        ],
        "mcp": {
            "roblox-studio": {
                "type": "local",
                "command": [bun_str, "x", MCP_PACKAGE],
                "enabled": true
            }
        }
    });
    let config_content = serde_json::to_string(&mcp_config)
        .map_err(|e| format!("Failed to serialize OpenCode config: {e}"))?;

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

    // Build a minimal PATH that includes our sidecar directory and essential system paths.
    // This prevents OpenCode from accidentally using system-installed binaries.
    let sidecar_dir = opencode_bin
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    #[cfg(unix)]
    let minimal_path = format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", sidecar_dir);
    #[cfg(windows)]
    let minimal_path = format!(
        "{};C:\\Windows\\System32;C:\\Windows",
        sidecar_dir
    );

    let mut child = Command::new(&opencode_bin)
        .arg("serve")
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
        // Minimal PATH to prevent picking up system binaries
        .env("PATH", &minimal_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start OpenCode server: {e}"))?;

    eprintln!("[opencode] Isolated environment: {}", opencode_home.display());
    eprintln!("[opencode] PATH: {}", minimal_path);

    // Capture stderr for logging (all lines)
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[opencode:err] {line}");
            }
        });
    }

    // Capture stdout for logging
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[opencode:out] {line}");
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
        set_status(&state, &app, OpenCodeStatus::Running).await;

        // Spawn the process exit monitor with auto-restart
        spawn_exit_monitor(Arc::clone(&state), app.clone());

        Ok(port)
    } else {
        let err = "OpenCode server started but health check timed out".to_string();
        set_status(&state, &app, OpenCodeStatus::Error(err.clone())).await;
        Err(err)
    }
}

/// Monitor the child process. If it exits unexpectedly, update status
/// and attempt auto-restart (up to MAX_RESTART_ATTEMPTS).
fn spawn_exit_monitor(state: SharedOpenCodeState, app: AppHandle) {
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
                            s.status = OpenCodeStatus::Stopped;
                            emit_status(&app, &s.status, s.port);
                        } else {
                            let msg = format!("Exited with {exit_status}");
                            eprintln!("[opencode] Process exited: {msg}");

                            // Auto-restart if we were previously running
                            // and haven't exceeded the attempt limit
                            if was_running
                                && s.restart_attempts < MAX_RESTART_ATTEMPTS
                            {
                                s.restart_attempts += 1;
                                let attempt = s.restart_attempts;
                                let port = s.port;
                                drop(s); // release lock before restart

                                eprintln!(
                                    "[opencode] Auto-restart attempt {attempt}/{MAX_RESTART_ATTEMPTS} in {RESTART_DELAY_SECS}s"
                                );
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
pub async fn kill_stale_mcp() -> Result<(), String> {
    eprintln!("[mcp] Killing stale robloxstudio-mcp processes");

    #[cfg(unix)]
    {
        // Kill by process name
        let _ = Command::new("pkill")
            .args(["-f", "robloxstudio-mcp"])
            .output()
            .await;
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/FI", "IMAGENAME eq bun.exe", "/FI", "COMMANDLINE eq *robloxstudio-mcp*"])
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
            eprintln!("[mcp] Port 3002 released");
            return Ok(());
        }
    }

    eprintln!("[mcp] Warning: port 3002 may still be in use");
    Ok(())
}
