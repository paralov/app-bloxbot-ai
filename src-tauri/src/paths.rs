use std::path::PathBuf;

// ── Sidecar binary resolution ───────────────────────────────────────────
//
// Tauri's `externalBin` places sidecar binaries next to the main executable
// (e.g. `YourApp.app/Contents/MacOS/` on macOS). At runtime we resolve them
// via `current_exe().parent().join(name)`. During `cargo tauri dev` this
// also works because the binaries are copied into the target directory.

/// Returns the directory containing the main executable (and all sidecars).
fn sidecar_dir() -> Result<PathBuf, String> {
    let exe = tauri::utils::platform::current_exe()
        .map_err(|e| format!("Could not determine current executable path: {e}"))?;
    exe.parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Current executable has no parent directory".to_string())
}

/// Resolves a sidecar binary by name. The name should match the filename
/// portion of the `externalBin` entry (without the target-triple suffix).
fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let bin_name = format!("{name}.exe");
    #[cfg(not(target_os = "windows"))]
    let bin_name = name.to_string();

    let path = sidecar_dir()?.join(&bin_name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "Sidecar binary '{}' not found at: {}",
            name,
            path.display()
        ))
    }
}

/// Returns the path to the bundled Bun sidecar binary.
pub fn bundled_bun_path() -> Result<PathBuf, String> {
    sidecar_path("bun")
}

/// Returns the path to the bundled OpenCode sidecar binary.
pub fn bundled_opencode_path() -> Result<PathBuf, String> {
    sidecar_path("opencode")
}

/// Returns the BloxBot workspace directory (`~/BloxBot`), creating it if
/// it does not exist. This is where OpenCode sessions operate.
pub fn workspace_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let workspace = home.join("BloxBot");
    if !workspace.exists() {
        std::fs::create_dir_all(&workspace)
            .map_err(|e| format!("Failed to create BloxBot workspace: {e}"))?;
    }
    Ok(workspace)
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_workspace_dir() -> Result<String, String> {
    workspace_dir().map(|p| p.to_string_lossy().to_string())
}
