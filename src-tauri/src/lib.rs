// lib.rs — Koji Baseline entry point
// Task 4: PTY → TerminalEngine → Canvas. I/O thread bridges the gap.
// Task 8: Ollama client wired in — streaming LLM queries from the terminal.

pub mod monitor;
pub mod ollama;
pub mod pty;
pub mod terminal;

use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

// ─── App State ────────────────────────────────────────────────────────────────

struct PtyState(Arc<Mutex<Option<pty::PtyManager>>>);
struct EngineState(Arc<Mutex<Option<terminal::TerminalEngine>>>);
struct OllamaState(Arc<AsyncMutex<ollama::OllamaClient>>);

// ─── PTY Commands ─────────────────────────────────────────────────────────────

/// Spin up a PTY + TerminalEngine, then launch the I/O thread that pumps bytes
/// from the shell into the engine and fires `terminal-output` events at the frontend.
#[tauri::command]
fn init_terminal(
    rows: Option<u16>,
    cols: Option<u16>,
    pty_state: State<'_, PtyState>,
    engine_state: State<'_, EngineState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    // Build the PTY — grab reader Arc before stashing the manager
    let manager = pty::PtyManager::new(rows, cols)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;
    let reader_arc = manager.take_reader();

    // Build the TerminalEngine
    let engine = terminal::TerminalEngine::new(rows as usize, cols as usize);

    // Seat both in state
    {
        let mut lock = pty_state.0.lock().unwrap();
        *lock = Some(manager);
    }
    {
        let mut lock = engine_state.0.lock().unwrap();
        *lock = Some(engine);
    }

    // Clone the engine Arc for the I/O thread
    let engine_arc = Arc::clone(&engine_state.0);

    // I/O thread: PTY bytes → engine → emit snapshot
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                let mut reader = reader_arc.lock().unwrap();
                match reader.read(&mut buf) {
                    Ok(0) => break,  // EOF — shell exited
                    Err(_) => break, // pipe broken
                    Ok(n) => n,
                }
            };

            let snapshot = {
                let mut eng_opt = engine_arc.lock().unwrap();
                if let Some(ref mut eng) = *eng_opt {
                    eng.process_bytes(&buf[..n]);
                    Some(eng.snapshot())
                } else {
                    None
                }
            };

            if let Some(snap) = snapshot {
                // Fire and forget — if the window closed, we'll catch it next iteration
                let _ = app.emit("terminal-output", &snap);
            }
        }
    });

    Ok(())
}

/// Send raw bytes to the shell — keypresses, paste, escape sequences, whatever.
#[tauri::command]
fn write_to_pty(data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    let lock = state.0.lock().unwrap();
    match lock.as_ref() {
        Some(mgr) => mgr.write(&data).map_err(|e| format!("PTY write failed: {e}")),
        None => Err("PTY not initialised — call init_terminal first".into()),
    }
}

/// Resize both the TerminalEngine. Call this when the window resizes.
#[tauri::command]
fn resize_terminal(
    rows: u16,
    cols: u16,
    engine_state: State<'_, EngineState>,
) -> Result<(), String> {
    let mut eng_opt = engine_state.0.lock().unwrap();
    if let Some(ref mut eng) = *eng_opt {
        eng.resize(rows as usize, cols as usize);
        Ok(())
    } else {
        Err("Terminal engine not initialised".into())
    }
}

// ─── Ollama Commands ──────────────────────────────────────────────────────────

/// Build message list from prompt + context strings, then stream the response.
/// Emits "llm-chunk" and "llm-status" events — no return value needed.
#[tauri::command]
async fn llm_query(
    prompt: String,
    context: Vec<String>,
    app: tauri::AppHandle,
    state: State<'_, OllamaState>,
) -> Result<(), String> {
    let mut messages: Vec<ollama::ChatMessage> = context
        .into_iter()
        .map(|c| ollama::ChatMessage {
            role: "user".to_string(),
            content: c,
        })
        .collect();

    messages.push(ollama::ChatMessage {
        role: "user".to_string(),
        content: prompt,
    });

    let client = state.0.lock().await;
    client.chat_stream(messages, &app).await
}

/// Hot-swap the active model without restarting.
#[tauri::command]
async fn switch_model(model: String, state: State<'_, OllamaState>) -> Result<(), String> {
    let mut client = state.0.lock().await;
    client.set_model(model);
    Ok(())
}

/// Ping Ollama and return its status — used by the frontend on startup.
#[tauri::command]
async fn check_ollama(state: State<'_, OllamaState>) -> Result<ollama::OllamaStatus, String> {
    let client = state.0.lock().await;
    Ok(client.check_status().await)
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PtyState(Arc::new(Mutex::new(None))))
        .manage(EngineState(Arc::new(Mutex::new(None))))
        .manage(OllamaState(Arc::new(AsyncMutex::new(
            ollama::OllamaClient::new(),
        ))))
        .invoke_handler(tauri::generate_handler![
            init_terminal,
            write_to_pty,
            resize_terminal,
            llm_query,
            switch_model,
            check_ollama,
        ])
        .setup(|app| {
            monitor::start_monitor(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
