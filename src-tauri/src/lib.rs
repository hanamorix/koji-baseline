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

/// Resize both the TerminalEngine and the PTY. Call this when the window resizes.
#[tauri::command]
fn resize_terminal(
    rows: u16,
    cols: u16,
    pty_state: State<'_, PtyState>,
    engine_state: State<'_, EngineState>,
) -> Result<(), String> {
    // Resize the terminal engine
    {
        let mut eng_opt = engine_state.0.lock().unwrap();
        if let Some(ref mut eng) = *eng_opt {
            eng.resize(rows as usize, cols as usize);
        }
    }
    // Resize the PTY — signals the child process too
    {
        let pty_lock = pty_state.0.lock().unwrap();
        if let Some(ref mgr) = *pty_lock {
            mgr.resize(rows, cols)?;
        }
    }
    Ok(())
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

/// List all models available in Ollama (/api/tags).
#[tauri::command]
async fn ollama_list_models(state: State<'_, OllamaState>) -> Result<Vec<String>, String> {
    let client = state.0.lock().await;
    client.list_models().await
}

/// Pull a model from the Ollama registry (/api/pull, stream:false).
#[tauri::command]
async fn ollama_pull_model(model: String, state: State<'_, OllamaState>) -> Result<(), String> {
    let client = state.0.lock().await;
    client.pull_model(model).await
}

// ─── Theme Commands ───────────────────────────────────────────────────────────

/// Update the terminal engine's colour mapping at runtime.
/// `colors` is a JSON object of { "black": [r,g,b], "red": [r,g,b], … }
#[tauri::command]
fn set_theme_colors(
    colors: serde_json::Value,
    engine_state: State<'_, EngineState>,
) -> Result<(), String> {
    let mut lock = engine_state.0.lock().unwrap();
    if let Some(ref mut eng) = *lock {
        eng.set_theme_colors(&colors);
    }
    Ok(())
}

/// Config file path: ~/.koji-baseline/config.json
fn config_path() -> std::path::PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    p.push(".koji-baseline");
    p.push("config.json");
    p
}

/// Persist a key/value string pair to ~/.koji-baseline/config.json.
#[tauri::command]
fn save_config(key: String, value: String) -> Result<(), String> {
    let path = config_path();
    // Create parent dir if needed
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }

    // Read existing config or start fresh
    let mut map: serde_json::Map<String, serde_json::Value> = if path.exists() {
        let raw = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        serde_json::Map::new()
    };

    map.insert(key, serde_json::Value::String(value));
    let out = serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|e| format!("JSON serialise failed: {e}"))?;
    std::fs::write(&path, out).map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

/// Load a value from ~/.koji-baseline/config.json by key.
/// Returns empty string if the key or file doesn't exist.
#[tauri::command]
fn load_config(key: String) -> String {
    let path = config_path();
    if !path.exists() {
        return String::new();
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&raw).unwrap_or_default();
    map.get(&key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
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
            ollama_list_models,
            ollama_pull_model,
            set_theme_colors,
            save_config,
            load_config,
        ])
        .setup(|app| {
            monitor::start_monitor(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
