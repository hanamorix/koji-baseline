// lib.rs — Koji Baseline entry point
// v0.6: SessionMap — per-tab PTY with scoped events. Ollama + OpenAI-compat streaming.

pub mod monitor;
pub mod ollama;
pub mod openai_compat;
pub mod pty;
pub mod osc;
pub mod terminal;

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

// ─── App State ────────────────────────────────────────────────────────────────

struct Session {
    pty: pty::PtyManager,
    engine: terminal::TerminalEngine,
}

struct SessionMap(Arc<Mutex<HashMap<String, Session>>>);

struct OllamaState(Arc<AsyncMutex<ollama::OllamaClient>>);
struct OpenAICompatState(Arc<AsyncMutex<openai_compat::OpenAICompatClient>>);

// ─── Session Commands ─────────────────────────────────────────────────────────

/// Create a new terminal session — PTY + engine + I/O thread — keyed by the provided tab ID.
/// Returns the tab ID so the frontend can scope all subsequent calls.
#[tauri::command]
fn create_session(
    tab_id: String,
    rows: Option<u16>,
    cols: Option<u16>,
    sessions: State<'_, SessionMap>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let rows = rows.unwrap_or(24);
    let cols = cols.unwrap_or(80);

    // Build the PTY — grab reader Arc BEFORE stashing in the map
    let manager = pty::PtyManager::new(rows, cols)
        .map_err(|e| format!("Failed to open PTY: {e}"))?;
    let reader_arc = manager.take_reader();

    // Build the TerminalEngine
    let engine = terminal::TerminalEngine::new(rows as usize, cols as usize);

    // Insert session into the map
    {
        let mut map = sessions.0.lock();
        map.insert(tab_id.clone(), Session { pty: manager, engine });
    }

    // Clone what the I/O thread needs — Arc for the map, not a lock
    let sessions_arc = Arc::clone(&sessions.0);
    let thread_tab_id = tab_id.clone();
    let app_handle = app.clone();

    // I/O thread: PTY bytes → engine → emit scoped events
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Pre-compute event names to avoid allocation in the hot loop
        let ev_output = format!("terminal-output-{}", thread_tab_id);
        let ev_scrollback = format!("scrollback-append-{}", thread_tab_id);
        let ev_bell = format!("terminal-bell-{}", thread_tab_id);
        let ev_closed = format!("session-closed-{}", thread_tab_id);
        loop {
            // Read from PTY — NO SessionMap lock held (this can block)
            let n = {
                let mut reader = reader_arc.lock().unwrap();
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break, // EOF or pipe broken
                    Ok(n) => n,
                }
            };

            let has_bell = terminal::TerminalEngine::check_bell(&buf[..n]);

            // Lock SessionMap briefly to process bytes and snapshot
            let (scrollback, snap) = {
                let mut map = sessions_arc.lock();
                match map.get_mut(&thread_tab_id) {
                    Some(session) => {
                        session.engine.process_bytes(&buf[..n]);
                        let sb = session.engine.drain_scrollback();
                        let s = session.engine.snapshot();
                        (sb, Some(s))
                    }
                    None => break, // Session was closed externally
                }
            }; // Lock released here

            // Emit events (no lock held)
            if !scrollback.is_empty() {
                let _ = app_handle.emit(&ev_scrollback, &scrollback);
            }
            if let Some(snap) = snap {
                let _ = app_handle.emit(&ev_output, &snap);
            }
            if has_bell {
                let _ = app_handle.emit(&ev_bell, ());
            }
        }

        // Cleanup on thread exit — shell died or session was removed
        {
            let mut map = sessions_arc.lock();
            map.remove(&thread_tab_id);
        }
        let _ = app_handle.emit(&ev_closed, ());
    });

    Ok(tab_id)
}

/// Send raw bytes to a specific session's PTY — keypresses, paste, escape sequences.
#[tauri::command]
fn write_to_session(tab_id: String, data: Vec<u8>, sessions: State<'_, SessionMap>) -> Result<(), String> {
    let map = sessions.0.lock();
    match map.get(&tab_id) {
        Some(session) => session.pty.write(&data).map_err(|e| format!("PTY write failed: {e}")),
        None => Err(format!("No session with id '{tab_id}'")),
    }
}

/// Resize a specific session's PTY + engine. Call when the tab's viewport changes.
#[tauri::command]
fn resize_session(
    tab_id: String,
    rows: u16,
    cols: u16,
    sessions: State<'_, SessionMap>,
) -> Result<(), String> {
    let mut map = sessions.0.lock();
    match map.get_mut(&tab_id) {
        Some(session) => {
            session.engine.resize(rows as usize, cols as usize);
            session.pty.resize(rows, cols)?;
            Ok(())
        }
        None => Err(format!("No session with id '{tab_id}'")),
    }
}

/// Tear down a session — removes it from the map. The I/O thread will notice and exit.
#[tauri::command]
fn close_session(tab_id: String, sessions: State<'_, SessionMap>) -> Result<(), String> {
    let mut map = sessions.0.lock();
    match map.remove(&tab_id) {
        Some(_) => Ok(()),
        None => Err(format!("No session with id '{tab_id}'")),
    }
}

// ─── Ollama Commands ──────────────────────────────────────────────────────────

/// Build message list from prompt + context strings, then stream the response.
/// Emits "llm-chunk" and "llm-status" events — no return value needed.
#[tauri::command]
async fn llm_query(
    prompt: String,
    context: Vec<String>,
    tools: Option<Vec<serde_json::Value>>,
    app: tauri::AppHandle,
    state: State<'_, OllamaState>,
) -> Result<(), String> {
    let mut messages: Vec<ollama::ChatMessage> = context
        .into_iter()
        .map(|c| ollama::ChatMessage {
            role: "user".to_string(),
            content: c,
            tool_calls: None,
            tool_call_id: None,
        })
        .collect();

    messages.push(ollama::ChatMessage {
        role: "user".to_string(),
        content: prompt,
        tool_calls: None,
        tool_call_id: None,
    });

    let client = state.0.lock().await;
    client.chat_stream(messages, tools, &app).await
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

// ─── OpenAI-Compatible Commands ───────────────────────────────────────────────

/// Stream a chat completion through an OpenAI-compatible provider.
/// Accepts base_url, api_key, and model so any Together/Groq/Fireworks endpoint works.
#[tauri::command]
async fn openai_chat_stream(
    base_url: String,
    api_key: String,
    model: String,
    messages: Vec<openai_compat::OpenAIChatMessage>,
    tools: Option<Vec<openai_compat::ToolDefinition>>,
    app: tauri::AppHandle,
    state: State<'_, OpenAICompatState>,
) -> Result<(), String> {
    let client = state.0.lock().await;
    client.chat_stream(&base_url, &api_key, &model, messages, tools, &app).await
}

/// List models from an OpenAI-compatible /v1/models endpoint.
#[tauri::command]
async fn openai_list_models(
    base_url: String,
    api_key: String,
    state: State<'_, OpenAICompatState>,
) -> Result<Vec<String>, String> {
    let client = state.0.lock().await;
    client.list_models(&base_url, &api_key).await
}

// ─── Filesystem Commands ──────────────────────────────────────────────────────

/// Resolve a path (expanding `~/`) and return whether it is a "file",
/// "directory", or null if it does not exist / is not accessible.
#[tauri::command]
fn check_path_type(path: String) -> Option<String> {
    let expanded = if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&path[2..])
        } else {
            std::path::PathBuf::from(&path)
        }
    } else {
        std::path::PathBuf::from(&path)
    };
    match std::fs::metadata(&expanded) {
        Ok(meta) if meta.is_dir()  => Some("directory".to_string()),
        Ok(meta) if meta.is_file() => Some("file".to_string()),
        _ => None,
    }
}

/// Open a URL in the system default browser (macOS `open`).
/// Only allows http:// and https:// schemes to prevent file:// and other scheme abuse.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("Refused to open non-HTTP URL: {url}"));
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

/// Open a file in $EDITOR, or fall back to `open` (macOS default app).
/// Expands `~/` in the path before passing it to the process.
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let expanded = if path.starts_with("~/") {
        dirs::home_dir()
            .map(|h| h.join(&path[2..]).to_string_lossy().to_string())
            .unwrap_or(path.clone())
    } else {
        path.clone()
    };

    if let Ok(editor) = std::env::var("EDITOR") {
        std::process::Command::new(&editor)
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to open in {editor}: {e}"))?;
    } else {
        std::process::Command::new("open")
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    Ok(())
}

// ─── Theme Commands ───────────────────────────────────────────────────────────

/// Update the terminal engine's colour mapping at runtime for a specific session.
/// `colors` is a JSON object of { "black": [r,g,b], "red": [r,g,b], … }
/// Emits "theme-applied-{tab_id}" so the frontend can force a grid redraw.
#[tauri::command]
fn set_theme_colors(
    colors: serde_json::Value,
    sessions: State<'_, SessionMap>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut map = sessions.0.lock();
    for session in map.values_mut() {
        session.engine.set_theme_colors(&colors);
    }
    let _ = app.emit("theme-applied", ());
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

// ─── Agent Tool Commands ──────────────────────────────────────────────────────

/// Run a shell command via `/bin/sh -c "..."`. Captures stdout + stderr.
/// Optional `cwd` overrides the working directory.
#[tauri::command]
async fn agent_run_command(command: String, cwd: Option<String>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c").arg(&command);
    if let Some(ref dir) = cwd {
        let expanded = expand_tilde(dir);
        cmd.current_dir(&expanded);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run command: {e}"))?;
    let mut result = String::new();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("[stderr]\n");
        result.push_str(&stderr);
    }
    if result.is_empty() {
        result.push_str("[no output]");
    }
    Ok(result)
}

/// Expand a leading `~/` to the user's home directory.
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]);
        }
    }
    std::path::PathBuf::from(path)
}

/// Read a file, optionally returning only lines [start_line, end_line] (1-indexed, inclusive).
#[tauri::command]
fn agent_read_file(
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<String, String> {
    let expanded = expand_tilde(&path);
    let content =
        std::fs::read_to_string(&expanded).map_err(|e| format!("Read failed: {e}"))?;

    match (start_line, end_line) {
        (None, None) => Ok(content),
        _ => {
            let start = start_line.unwrap_or(1).saturating_sub(1); // convert to 0-indexed
            let lines: Vec<&str> = content.lines().collect();
            let end = end_line.unwrap_or(lines.len()).min(lines.len());
            if start >= lines.len() {
                return Ok(String::new());
            }
            Ok(lines[start..end].join("\n"))
        }
    }
}

/// Write content to a file, creating parent directories as needed.
#[tauri::command]
fn agent_write_file(path: String, content: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    if let Some(parent) = expanded.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    std::fs::write(&expanded, content).map_err(|e| format!("Write failed: {e}"))
}

/// Find and replace the first occurrence of `old_text` in a file.
/// Returns an error if `old_text` is not found.
#[tauri::command]
fn agent_edit_file(path: String, old_text: String, new_text: String) -> Result<(), String> {
    let expanded = expand_tilde(&path);
    let content =
        std::fs::read_to_string(&expanded).map_err(|e| format!("Read failed: {e}"))?;
    if !content.contains(&old_text) {
        return Err(format!(
            "old_text not found in {path}: {:?}",
            &old_text[..old_text.len().min(80)]
        ));
    }
    let updated = content.replacen(&old_text, &new_text, 1);
    std::fs::write(&expanded, updated).map_err(|e| format!("Write failed: {e}"))
}

/// List directory entries. If `recursive` is true, walks the tree.
#[tauri::command]
fn agent_list_directory(path: String, recursive: Option<bool>) -> Result<String, String> {
    let expanded = expand_tilde(&path);
    let recurse = recursive.unwrap_or(false);

    if recurse {
        // Use find with proper argument separation — no shell interpolation
        let output = std::process::Command::new("find")
            .arg(&expanded)
            .arg("-not")
            .arg("-path")
            .arg("*/.*")
            .output()
            .map_err(|e| format!("find failed: {e}"))?;
        let mut lines: Vec<&str> = std::str::from_utf8(&output.stdout)
            .unwrap_or("")
            .lines()
            .collect();
        lines.sort();
        Ok(lines.join("\n"))
    } else {
        let entries = std::fs::read_dir(&expanded).map_err(|e| format!("readdir failed: {e}"))?;
        let mut lines: Vec<String> = entries
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().to_string_lossy().to_string();
                let suffix = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    "/"
                } else {
                    ""
                };
                Some(format!("{name}{suffix}"))
            })
            .collect();
        lines.sort();
        Ok(lines.join("\n"))
    }
}

/// Search file contents with ripgrep (or grep fallback). Returns matching lines.
#[tauri::command]
fn agent_search_files(
    pattern: String,
    path: Option<String>,
    glob: Option<String>,
) -> Result<String, String> {
    let search_path = path
        .as_deref()
        .map(expand_tilde)
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // Try ripgrep first, fall back to grep
    let rg_available = std::process::Command::new("which")
        .arg("rg")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let output = if rg_available {
        let mut args = vec![
            "--color=never".to_string(),
            "-n".to_string(),
            pattern.clone(),
            search_path.to_string_lossy().to_string(),
        ];
        if let Some(ref g) = glob {
            args.insert(0, g.clone());
            args.insert(0, "--glob".to_string());
        }
        std::process::Command::new("rg")
            .args(&args)
            .output()
            .map_err(|e| format!("rg failed: {e}"))?
    } else {
        let mut grep_args = vec![
            "-rn".to_string(),
            pattern.clone(),
        ];
        if let Some(ref g) = glob {
            grep_args.push(format!("--include={}", g));
        }
        grep_args.push(search_path.to_string_lossy().to_string());
        std::process::Command::new("grep")
            .args(&grep_args)
            .output()
            .map_err(|e| format!("grep failed: {e}"))?
    };

    let result = String::from_utf8_lossy(&output.stdout).into_owned();
    if result.is_empty() {
        Ok("[no matches]".to_string())
    } else {
        Ok(result)
    }
}

/// Search for files by name pattern using `find`.
#[tauri::command]
fn agent_search_filenames(pattern: String, path: Option<String>) -> Result<String, String> {
    let search_path = path
        .as_deref()
        .map(expand_tilde)
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let output = std::process::Command::new("find")
        .arg(&search_path)
        .arg("-name")
        .arg(&pattern)
        .output()
        .map_err(|e| format!("find failed: {e}"))?;

    let result = String::from_utf8_lossy(&output.stdout).into_owned();
    if result.is_empty() {
        Ok("[no matches]".to_string())
    } else {
        Ok(result)
    }
}

/// Fetch a URL via HTTP GET and return the response body as text.
#[tauri::command]
async fn agent_fetch_url(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("koji-baseline-agent/0.3")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Client build failed: {e}"))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Body read failed: {e}"))?;

    if !status.is_success() {
        Ok(format!("[HTTP {status}]\n{body}"))
    } else {
        Ok(body)
    }
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionMap(Arc::new(Mutex::new(HashMap::new()))))
        .manage(OllamaState(Arc::new(AsyncMutex::new(
            ollama::OllamaClient::new(),
        ))))
        .manage(OpenAICompatState(Arc::new(AsyncMutex::new(
            openai_compat::OpenAICompatClient::new(),
        ))))
        .invoke_handler(tauri::generate_handler![
            create_session,
            write_to_session,
            resize_session,
            close_session,
            llm_query,
            switch_model,
            check_ollama,
            ollama_list_models,
            ollama_pull_model,
            set_theme_colors,
            save_config,
            load_config,
            check_path_type,
            open_url,
            open_file,
            openai_chat_stream,
            openai_list_models,
            agent_run_command,
            agent_read_file,
            agent_write_file,
            agent_edit_file,
            agent_list_directory,
            agent_search_files,
            agent_search_filenames,
            agent_fetch_url,
        ])
        .setup(|app| {
            monitor::start_monitor(app.handle().clone());

            // Load saved model from config on startup
            use tauri::Manager;
            let ollama: Arc<AsyncMutex<ollama::OllamaClient>> =
                app.state::<OllamaState>().0.clone();
            let config_path = dirs::home_dir()
                .map(|h| h.join(".koji-baseline").join("config.json"));
            if let Some(path) = config_path {
                if let Ok(data) = std::fs::read_to_string(&path) {
                    if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
                        if let Some(model) = config.get("activeModel").and_then(|v| v.as_str()) {
                            let model = model.to_string();
                            tauri::async_runtime::spawn(async move {
                                let mut client = ollama.lock().await;
                                client.set_model(model);
                            });
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
