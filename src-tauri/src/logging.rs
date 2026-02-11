//! Application logging system.
//!
//! Implements the `log` crate's `Log` trait with three outputs:
//!
//! 1. **Ring buffer** – the last `MAX_ENTRIES` log entries are kept in memory
//!    so the debug-logs window can display the full history from app start.
//! 2. **stderr** – every entry is printed for `cargo tauri dev` / terminal use.
//! 3. **Tauri event** – each entry is emitted as `log-entry` to all webviews
//!    so the debug-logs window receives entries in real-time.
//!
//! No files are written to disk.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter};

// ── Types ───────────────────────────────────────────────────────────────

/// A single log entry stored in the ring buffer and sent to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogEntry {
    /// Milliseconds since UNIX epoch (UTC).
    pub timestamp: u64,
    /// Severity: "ERROR", "WARN", "INFO", "DEBUG", "TRACE".
    pub level: &'static str,
    /// The log message.
    pub message: String,
}

const MAX_ENTRIES: usize = 5000;

// ── Global state ────────────────────────────────────────────────────────

/// The ring buffer holding recent log entries.
static LOG_BUFFER: OnceLock<Mutex<VecDeque<LogEntry>>> = OnceLock::new();

/// The Tauri `AppHandle`, set once during `setup`. Before it is set, log
/// entries still go to the buffer + stderr but no events are emitted.
static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

fn buffer() -> &'static Mutex<VecDeque<LogEntry>> {
    LOG_BUFFER.get_or_init(|| Mutex::new(VecDeque::with_capacity(MAX_ENTRIES)))
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Public API ──────────────────────────────────────────────────────────

/// Initialise the global logger. Call once, before any `log::` macros.
///
/// This sets the `log` crate's global logger to our `AppLogger` and the
/// max level to `Debug` (TRACE is suppressed — it's all framework noise).
pub fn init() {
    let _ = log::set_logger(&AppLogger);
    log::set_max_level(log::LevelFilter::Debug);
}

/// Provide the `AppHandle` so the logger can emit events to webviews.
/// Called from `setup` once the Tauri app is initialised.
pub fn set_app_handle(handle: AppHandle) {
    let cell = APP_HANDLE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(handle);
    }
}

// ── log::Log implementation ─────────────────────────────────────────────

struct AppLogger;

impl log::Log for AppLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        // Accept everything up to Debug. TRACE is filtered at set_max_level
        // but we double-check here.
        metadata.level() <= log::Level::Debug
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        let level_str = match record.level() {
            log::Level::Error => "ERROR",
            log::Level::Warn => "WARN",
            log::Level::Info => "INFO",
            log::Level::Debug => "DEBUG",
            log::Level::Trace => "TRACE",
        };

        let message = format!("{}", record.args());

        let entry = LogEntry {
            timestamp: epoch_millis(),
            level: level_str,
            message,
        };

        // 1. stderr (for terminal / cargo tauri dev)
        let ts = format_time(entry.timestamp);
        eprintln!("[{ts}][{level_str}] {}", entry.message);

        // 2. Ring buffer
        if let Ok(mut buf) = buffer().lock() {
            buf.push_back(entry.clone());
            if buf.len() > MAX_ENTRIES {
                buf.pop_front();
            }
        }

        // 3. Tauri event to all webviews
        if let Some(cell) = APP_HANDLE.get() {
            if let Ok(guard) = cell.lock() {
                if let Some(handle) = guard.as_ref() {
                    let _ = handle.emit("log-entry", &entry);
                }
            }
        }
    }

    fn flush(&self) {}
}

/// Format epoch millis as `HH:MM:SS` (UTC) for stderr output.
fn format_time(millis: u64) -> String {
    let secs = (millis / 1000) % 86400;
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

// ── Tauri commands ──────────────────────────────────────────────────────

/// Return all buffered log entries (history since app start).
#[tauri::command]
pub fn get_logs() -> Vec<LogEntry> {
    match buffer().lock() {
        Ok(buf) => buf.iter().cloned().collect(),
        Err(e) => e.into_inner().iter().cloned().collect(),
    }
}
