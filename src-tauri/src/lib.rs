// lib.rs — Koji Baseline entry point
// Task 4: PTY → TerminalEngine → Canvas. I/O thread bridges the gap.
// Task 8: Ollama client wired in — streaming LLM queries from the terminal.

pub mod monitor;
pub mod ollama;
pub mod openai_compat;
pub mod pty;
pub mod terminal;

use std::io::Read;
use std::sync::Arc;
use parking_lot::Mutex;
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

// ─── App State ────────────────────────────────────────────────────────────────

struct PtyState(Arc<Mutex<Option<pty::PtyManager>>>);
struct EngineState(Arc<Mutex<Option<terminal::TerminalEngine>>>);
struct OllamaState(Arc<AsyncMutex<ollama::OllamaClient>>);
struct OpenAICompatState(Arc<AsyncMutex<openai_compat::OpenAICompatClient>>);

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
        let mut lock = pty_state.0.lock();
        *lock = Some(manager);
    }
    {
        let mut lock = engine_state.0.lock();
        *lock = Some(engine);
    }

    // Clone the engine Arc for the I/O thread
    let engine_arc = Arc::clone(&engine_state.0);

    // I/O thread: PTY bytes → engine → emit snapshot
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                // reader_arc is a std::sync::Mutex from pty.rs — .lock() returns Result
                let mut reader = reader_arc.lock().unwrap();
                match reader.read(&mut buf) {
                    Ok(0) => break,  // EOF — shell exited
                    Err(_) => break, // pipe broken
                    Ok(n) => n,
                }
            };

            let has_bell = terminal::TerminalEngine::check_bell(&buf[..n]);

            let (snapshot, scrollback) = {
                let mut eng_opt = engine_arc.lock();
                if let Some(ref mut eng) = *eng_opt {
                    eng.process_bytes(&buf[..n]);
                    let sb = eng.drain_scrollback();
                    (Some(eng.snapshot()), sb)
                } else {
                    (None, Vec::new())
                }
            };

            // Emit new scrollback lines before the viewport snapshot so the
            // frontend can prepend them before the grid repaints.
            if !scrollback.is_empty() {
                let _ = app.emit("scrollback-append", &scrollback);
            }

            if let Some(snap) = snapshot {
                // Fire and forget — if the window closed, we'll catch it next iteration
                let _ = app.emit("terminal-output", &snap);
            }

            if has_bell {
                let _ = app.emit("terminal-bell", ());
            }
        }
    });

    Ok(())
}

/// Send raw bytes to the shell — keypresses, paste, escape sequences, whatever.
#[tauri::command]
fn write_to_pty(data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    let lock = state.0.lock();
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
        let mut eng_opt = engine_state.0.lock();
        if let Some(ref mut eng) = *eng_opt {
            eng.resize(rows as usize, cols as usize);
        }
    }
    // Resize the PTY — signals the child process too
    {
        let pty_lock = pty_state.0.lock();
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
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
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

/// Update the terminal engine's colour mapping at runtime.
/// `colors` is a JSON object of { "black": [r,g,b], "red": [r,g,b], … }
/// Emits "theme-applied" so the frontend can force a grid redraw.
#[tauri::command]
fn set_theme_colors(
    colors: serde_json::Value,
    engine_state: State<'_, EngineState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut lock = engine_state.0.lock();
    if let Some(ref mut eng) = *lock {
        eng.set_theme_colors(&colors);
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
        // Use the shell for simplicity and to respect .gitignore naturally
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!(
                "find {} -not -path '*/\\.*' | sort",
                expanded.to_string_lossy()
            ))
            .output()
            .map_err(|e| format!("find failed: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
        let mut cmd_str = format!(
            "grep -rn {} {}",
            shell_escape(&pattern),
            search_path.to_string_lossy()
        );
        if let Some(ref g) = glob {
            cmd_str = format!(
                "grep -rn {} --include={} {}",
                shell_escape(&pattern),
                shell_escape(g),
                search_path.to_string_lossy()
            );
        }
        std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&cmd_str)
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

/// Minimal shell escaping — wraps in single quotes and escapes internal single quotes.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
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
        .manage(PtyState(Arc::new(Mutex::new(None))))
        .manage(EngineState(Arc::new(Mutex::new(None))))
        .manage(OllamaState(Arc::new(AsyncMutex::new(
            ollama::OllamaClient::new(),
        ))))
        .manage(OpenAICompatState(Arc::new(AsyncMutex::new(
            openai_compat::OpenAICompatClient::new(),
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
