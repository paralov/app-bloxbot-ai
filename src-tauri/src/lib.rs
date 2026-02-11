mod opencode;
mod paths;

use opencode::SharedOpenCodeState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let opencode_state: SharedOpenCodeState =
        Arc::new(Mutex::new(opencode::OpenCodeState::default()));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_posthog::init(tauri_plugin_posthog::PostHogConfig {
            api_key: "phc_4LeGCHJx8ymSSCZd3hf5QK8nlq3Sf1ZSC8nyRLc2JY4".to_string(),
            api_host: "https://eu.i.posthog.com".to_string(),
            options: None,
        }))
        .manage(opencode_state)
        .invoke_handler(tauri::generate_handler![
            opencode::get_opencode_status,
            opencode::kill_stale_mcp,
            paths::get_workspace_dir,
            paths::check_plugin_installed,
            paths::install_studio_plugin,
        ])
        .setup(|app| {
            // ── Application menu ──────────────────────────────────
            let app_submenu = SubmenuBuilder::new(app, "BloxBot")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_submenu = SubmenuBuilder::new(app, "View")
                .fullscreen()
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .close_window()
                .build()?;

            let debug_toggle = MenuItemBuilder::with_id("debug_opencode_ui", "OpenCode Web UI")
                .accelerator("CmdOrCtrl+Shift+D")
                .build(app)?;

            let debug_submenu = SubmenuBuilder::new(app, "Debug")
                .item(&debug_toggle)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .item(&view_submenu)
                .item(&window_submenu)
                .item(&debug_submenu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app_handle, event| {
                if event.id() == debug_toggle.id() {
                    // Open the OpenCode web UI in the default system browser
                    let state = app_handle.state::<SharedOpenCodeState>().inner().clone();
                    let handle = app_handle.clone();
                    tauri::async_runtime::spawn(async move {
                        let port = {
                            let s = state.lock().await;
                            s.port
                        };
                        if port > 0 {
                            let url = format!("http://127.0.0.1:{}", port);
                            let _ = handle.opener().open_url(&url, None::<&str>);
                        }
                    });
                }
            });

            // ── Updater plugin ────────────────────────────────────
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // ── Auto-start OpenCode server ────────────────────────
            let state = app
                .state::<SharedOpenCodeState>()
                .inner()
                .clone();
            let handle = app.handle().clone();
            log::info!("BloxBot starting up");
            tauri::async_runtime::spawn(async move {
                match opencode::start_opencode_server(state, handle).await {
                    Ok(port) => log::info!("OpenCode started on port {port}"),
                    Err(e) => log::error!("Failed to auto-start OpenCode: {e}"),
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Only kill the OpenCode server when the main window closes
                if window.label() != "main" {
                    return;
                }
                let state = window
                    .app_handle()
                    .state::<SharedOpenCodeState>()
                    .inner()
                    .clone();
                tauri::async_runtime::block_on(async {
                    let mut s = state.lock().await;
                    if let Some(ref mut child) = s.child {
                        let _ = child.kill().await;
                    }
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running BloxBot");
}
