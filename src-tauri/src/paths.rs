use std::path::PathBuf;
use tauri::Manager;

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

/// Returns the path to the bundled Node.js bin directory from resources.
/// This directory contains node, npm, and npx.
///
/// Production macOS: `<App>/Contents/Resources/nodejs/bin/`
/// Production Windows: `<App>/nodejs/bin`
/// Dev: `src-tauri/resources/nodejs/bin`
pub fn bundled_nodejs_bin_dir() -> Result<PathBuf, String> {
    let sidecar = sidecar_dir()?;

    // Production layout on macOS: <App>/Contents/MacOS/../Resources/nodejs/bin
    #[cfg(target_os = "macos")]
    let prod_path = sidecar
        .parent()
        .map(|p| p.join("Resources").join("nodejs").join("bin"))
        .unwrap_or_default();
    // Production layout on Windows: next to the exe
    #[cfg(not(target_os = "macos"))]
    let prod_path = sidecar.join("nodejs").join("bin");

    if prod_path.exists() {
        return Ok(prod_path);
    }

    // Dev layout: during `cargo tauri dev`, sidecar is at src-tauri/target/debug/
    // We need to go up to src-tauri/ then into resources/
    // sidecar/../../resources/nodejs/bin
    let dev_path = sidecar
        .parent() // target/
        .and_then(|p| p.parent()) // src-tauri/
        .map(|p| p.join("resources").join("nodejs").join("bin"))
        .unwrap_or_default();

    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err(format!(
        "Bundled Node.js not found. Checked:\n  {}\n  {}",
        prod_path.display(),
        dev_path.display()
    ))
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

// ── Studio plugin ────────────────────────────────────────────────────────

const PLUGIN_FILENAME: &str = "MCPPlugin.rbxmx";

/// Returns the Roblox Studio plugins directory for the current platform.
///   macOS:   ~/Documents/Roblox/Plugins
///   Windows: %LOCALAPPDATA%/Roblox/Plugins
fn roblox_plugins_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home =
            dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
        Ok(home.join("Documents").join("Roblox").join("Plugins"))
    }
    #[cfg(target_os = "windows")]
    {
        let local_app = dirs::data_local_dir()
            .ok_or_else(|| "Could not determine LOCALAPPDATA directory".to_string())?;
        Ok(local_app.join("Roblox").join("Plugins"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Roblox Studio plugins are only supported on macOS and Windows".to_string())
    }
}

/// Returns the path to the bundled MCPPlugin.rbxmx inside the app resources.
///
/// In production the Tauri resource mapping `resources/studio-plugin/*` -> `studio-plugin/`
/// places the file at `<resource_dir>/studio-plugin/MCPPlugin.rbxmx`.
///
/// During `cargo tauri dev` the resource dir points to `src-tauri/` so the
/// file lives at `src-tauri/resources/studio-plugin/MCPPlugin.rbxmx`.
fn bundled_plugin_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not determine resource directory: {e}"))?;

    // Production layout
    let prod_path = resource_dir.join("studio-plugin").join(PLUGIN_FILENAME);
    if prod_path.exists() {
        return Ok(prod_path);
    }

    // Dev layout: resources are under src-tauri/resources/
    let dev_path = resource_dir
        .join("resources")
        .join("studio-plugin")
        .join(PLUGIN_FILENAME);
    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err(format!(
        "Bundled plugin not found. Checked:\n  {}\n  {}",
        prod_path.display(),
        dev_path.display()
    ))
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_workspace_dir() -> Result<String, String> {
    workspace_dir().map(|p| p.to_string_lossy().to_string())
}

/// Check whether the MCPPlugin.rbxmx file exists in the Roblox plugins dir.
#[tauri::command]
pub fn check_plugin_installed() -> Result<bool, String> {
    let dest = roblox_plugins_dir()?.join(PLUGIN_FILENAME);
    Ok(dest.exists())
}

/// Copy the bundled MCPPlugin.rbxmx into the Roblox plugins directory.
/// Creates the plugins directory if it does not exist.
#[tauri::command]
pub fn install_studio_plugin(app: tauri::AppHandle) -> Result<String, String> {
    let source = bundled_plugin_path(&app)?;
    let plugins_dir = roblox_plugins_dir()?;

    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("Failed to create Roblox plugins directory: {e}"))?;
    }

    let dest = plugins_dir.join(PLUGIN_FILENAME);
    std::fs::copy(&source, &dest).map_err(|e| {
        format!(
            "Failed to copy plugin from {} to {}: {e}",
            source.display(),
            dest.display()
        )
    })?;

    eprintln!(
        "[plugin] Installed {} -> {}",
        source.display(),
        dest.display()
    );
    Ok(dest.to_string_lossy().to_string())
}
