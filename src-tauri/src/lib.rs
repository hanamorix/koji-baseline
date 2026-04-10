// lib.rs — Koji Baseline entry point
// PTY commands live here. Terminal engine commands will follow in Task 4.

pub mod pty;
pub mod terminal;

use std::sync::{Arc, Mutex};
use tauri::State;

// ─── App State ────────────────────────────────────────────────────────────────

struct PtyState(Arc<Mutex<Option<pty::PtyManager>>>);

// ─── Commands ─────────────────────────────────────────────────────────────────

/// Create a new PTY and spawn the user's shell. Call this once on app start.
#[tauri::command]
fn init_pty(
    rows: Option<u16>,
    cols: Option<u16>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    let manager = pty::PtyManager::new(rows, cols)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let mut lock = state.0.lock().unwrap();
    *lock = Some(manager);

    Ok(())
}

/// Send raw bytes to the shell — keypresses, paste, whatever.
#[tauri::command]
fn write_to_pty(data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(mgr) => mgr.write(&data).map_err(|e| format!("PTY write failed: {e}")),
        None => Err("PTY not initialised — call init_pty first".into()),
    }
}

/// Vestigial greet command from scaffold — keeping it alive until Task 4 cleans house.
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![greet, init_pty, write_to_pty])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
