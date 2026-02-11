mod logging;
mod opencode;
mod paths;

use opencode::SharedOpenCodeState;
use std::sync::Arc;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::webview::WebviewWindowBuilder;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialise the logger before anything else so the very first
    // log::info!() calls are captured in the ring buffer.
    logging::init();

    let opencode_state: SharedOpenCodeState =
        Arc::new(Mutex::new(opencode::OpenCodeState::default()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_posthog::init(
            tauri_plugin_posthog::PostHogConfig {
                api_key: "phc_4LeGCHJx8ymSSCZd3hf5QK8nlq3Sf1ZSC8nyRLc2JY4".to_string(),
                api_host: "https://eu.i.posthog.com".to_string(),
                options: None,
            },
        ))
        .manage(opencode_state)
        .invoke_handler(tauri::generate_handler![
            logging::get_logs,
            opencode::get_opencode_status,
            opencode::restart_opencode,
            opencode::kill_stale_mcp,
            paths::get_workspace_dir,
            paths::check_plugin_installed,
            paths::install_studio_plugin,
        ])
        .setup(|app| {
            // Give the logger access to the AppHandle so it can emit
            // events to webviews (the debug-logs window).
            logging::set_app_handle(app.handle().clone());

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

            let logs_toggle = MenuItemBuilder::with_id("debug_logs", "Debug Logs")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?;

            let debug_submenu = SubmenuBuilder::new(app, "Debug")
                .item(&debug_toggle)
                .item(&logs_toggle)
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
                } else if event.id() == logs_toggle.id() {
                    // Toggle the debug logs window
                    if let Some(win) = app_handle.get_webview_window("debug-logs") {
                        let _ = win.set_focus();
                    } else if let Err(e) = WebviewWindowBuilder::new(
                        app_handle,
                        "debug-logs",
                        tauri::WebviewUrl::App("debug-logs.html".into()),
                    )
                    .title("BloxBot - Debug Logs")
                    .inner_size(900.0, 500.0)
                    .min_inner_size(500.0, 300.0)
                    .build()
                    {
                        log::error!("Failed to create debug logs window: {e}");
                    }
                }
            });

            // ── Updater plugin ────────────────────────────────────
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // ── Auto-start OpenCode server ────────────────────────
            let state = app.state::<SharedOpenCodeState>().inner().clone();
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
            // When the main window is closed, quit the entire app.
            if window.label() != "main" {
                return;
            }

            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    // Kill the OpenCode child process before the app exits.
                    let state = window
                        .app_handle()
                        .state::<SharedOpenCodeState>()
                        .inner()
                        .clone();
                    tauri::async_runtime::block_on(async {
                        let mut s = state.lock().await;
                        if let Some(child) = s.child.take() {
                            let _ = child.kill();
                        }
                    });
                    // Exit the entire app (closes all windows including debug-logs).
                    window.app_handle().exit(0);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running BloxBot");
}
