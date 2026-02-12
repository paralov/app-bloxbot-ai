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
    spawn_event_handler(rx, Arc::clone(&state), app.clone());

    // Wait for the server to be ready by polling the health endpoint
    let health_url = format!("http://{LOOPBACK}:{port}/global/health");
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
                log::info!(target: "opencode::stdout", "{}", text.trim_end());
            }
            CommandEvent::Stderr(line) => {
                let text = String::from_utf8_lossy(&line);
                log::warn!(target: "opencode::stderr", "{}", text.trim_end());
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

    let msg = format!(
        "Exited with code {:?} (signal {:?})",
        payload.code, payload.signal
    );
    log::warn!("Process exited: {msg}");
    s.status = OpenCodeStatus::Error(msg);
    emit_status(app, &s.status, s.port);
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

/// Manually restart the OpenCode server. Called by the frontend when the
/// user clicks the retry button after a crash.
#[tauri::command]
pub async fn restart_opencode(
    state: tauri::State<'_, SharedOpenCodeState>,
    app: AppHandle,
) -> Result<u16, String> {
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
                log::debug!("OpenCode /mcp response: {body}");
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
    log::debug!("Checking MCP health at {health_url}");
    match client.get(&health_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or(serde_json::Value::Null);
            log::debug!("MCP health response: {body}");
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
