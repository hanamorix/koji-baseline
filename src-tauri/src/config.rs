// config.rs — TOML config with hot reload, file watching, and JSON migration
// because JSON configs are for people who hate comments. and themselves.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ─── Default value functions ─────────────────────────────────────────────────
// serde(default = "...") needs standalone fns. yes, all of them. no, there's no shortcut.

fn default_theme() -> String { "wallace".into() }
fn default_font() -> String { "JetBrains Mono".into() }
fn default_font_size() -> u16 { 14 }
fn default_cursor_style() -> String { "block".into() }
fn default_true() -> bool { true }
fn default_min_duration() -> u64 { 10 }
fn default_suggest_debounce_ms() -> u64 { 500 }

fn default_new_tab() -> String { "cmd+t".into() }
fn default_close_tab() -> String { "cmd+w".into() }
fn default_next_tab() -> String { "cmd+shift+]".into() }
fn default_prev_tab() -> String { "cmd+shift+[".into() }
fn default_search() -> String { "cmd+f".into() }
fn default_clear() -> String { "cmd+k".into() }
fn default_palette() -> String { "cmd+shift+p".into() }
fn default_zone_up() -> String { "cmd+up".into() }
fn default_zone_down() -> String { "cmd+down".into() }
fn default_font_up() -> String { "cmd+=".into() }
fn default_font_down() -> String { "cmd+-".into() }
fn default_font_reset() -> String { "cmd+0".into() }
fn default_select_all() -> String { "cmd+a".into() }
fn default_copy() -> String { "cmd+c".into() }
fn default_paste() -> String { "cmd+v".into() }
fn default_split_right() -> String { "cmd+d".into() }
fn default_split_down() -> String { "cmd+shift+d".into() }

// ─── Config structs ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KojiConfig {
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub notifications: NotificationConfig,
    #[serde(default)]
    pub keybindings: KeybindingConfig,
    #[serde(default)]
    pub ai: AiConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    #[serde(default = "default_true")]
    pub shell_integration: bool,
    #[serde(default = "default_true")]
    pub option_as_meta: bool,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            font: default_font(),
            font_size: default_font_size(),
            cursor_style: default_cursor_style(),
            copy_on_select: true,
            shell_integration: true,
            option_as_meta: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_min_duration")]
    pub min_duration_seconds: u64,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_duration_seconds: default_min_duration(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingConfig {
    #[serde(default = "default_new_tab")]
    pub new_tab: String,
    #[serde(default = "default_close_tab")]
    pub close_tab: String,
    #[serde(default = "default_next_tab")]
    pub next_tab: String,
    #[serde(default = "default_prev_tab")]
    pub prev_tab: String,
    #[serde(default = "default_search")]
    pub search: String,
    #[serde(default = "default_clear")]
    pub clear: String,
    #[serde(default = "default_palette")]
    pub palette: String,
    #[serde(default = "default_zone_up")]
    pub zone_up: String,
    #[serde(default = "default_zone_down")]
    pub zone_down: String,
    #[serde(default = "default_font_up")]
    pub font_up: String,
    #[serde(default = "default_font_down")]
    pub font_down: String,
    #[serde(default = "default_font_reset")]
    pub font_reset: String,
    #[serde(default = "default_select_all")]
    pub select_all: String,
    #[serde(default = "default_copy")]
    pub copy: String,
    #[serde(default = "default_paste")]
    pub paste: String,
    #[serde(default = "default_split_right")]
    pub split_right: String,
    #[serde(default = "default_split_down")]
    pub split_down: String,
}

impl Default for KeybindingConfig {
    fn default() -> Self {
        Self {
            new_tab: default_new_tab(),
            close_tab: default_close_tab(),
            next_tab: default_next_tab(),
            prev_tab: default_prev_tab(),
            search: default_search(),
            clear: default_clear(),
            palette: default_palette(),
            zone_up: default_zone_up(),
            zone_down: default_zone_down(),
            font_up: default_font_up(),
            font_down: default_font_down(),
            font_reset: default_font_reset(),
            select_all: default_select_all(),
            copy: default_copy(),
            paste: default_paste(),
            split_right: default_split_right(),
            split_down: default_split_down(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    /// Auto-diagnose failed commands (exit code != 0) and show inline explanation
    #[serde(default = "default_true")]
    pub auto_diagnose: bool,
    /// Show context-aware command suggestions while typing
    #[serde(default = "default_true")]
    pub suggest_enabled: bool,
    /// Debounce delay (ms) before triggering suggestions
    #[serde(default = "default_suggest_debounce_ms")]
    pub suggest_debounce_ms: u64,
    /// Persist AI interactions to a searchable history file
    #[serde(default = "default_true")]
    pub history_file: bool,
    /// Enable AI blocks — rich inline panels for errors, diffs, and explanations
    #[serde(default = "default_true")]
    pub blocks_enabled: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            auto_diagnose: true,
            suggest_enabled: true,
            suggest_debounce_ms: default_suggest_debounce_ms(),
            history_file: true,
            blocks_enabled: true,
        }
    }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

pub fn config_dir() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".koji-baseline");
    p
}

pub fn config_path() -> PathBuf {
    config_dir().join("config.toml")
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

/// Load config from TOML. If missing or malformed, returns defaults.
/// Partial configs work fine — serde fills the gaps.
pub fn load() -> KojiConfig {
    let path = config_path();
    if !path.exists() {
        return KojiConfig::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(raw) => toml::from_str(&raw).unwrap_or_default(),
        Err(_) => KojiConfig::default(),
    }
}

/// Serialize config to TOML and write to disk.
pub fn save(config: &KojiConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let out = toml::to_string_pretty(config).map_err(|e| format!("TOML serialize failed: {e}"))?;
    std::fs::write(&path, out).map_err(|e| format!("Write failed: {e}"))
}

/// Create default config.toml if it doesn't exist. Migrates values from config.json if present.
pub fn ensure_default_config() -> Result<(), String> {
    let path = config_path();
    if path.exists() {
        return Ok(());
    }

    // Start with defaults
    let mut config = KojiConfig::default();

    // Migrate from JSON if it exists
    let json_path = config_dir().join("config.json");
    if json_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&json_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(v) = json.get("theme").and_then(|v| v.as_str()) {
                    config.terminal.theme = v.to_string();
                }
                if let Some(v) = json.get("font").and_then(|v| v.as_str()) {
                    config.terminal.font = v.to_string();
                }
                if let Some(v) = json.get("font_size").and_then(|v| v.as_str()) {
                    if let Ok(n) = v.parse::<u16>() {
                        config.terminal.font_size = n;
                    }
                }
                if let Some(v) = json.get("cursor_style").and_then(|v| v.as_str()) {
                    config.terminal.cursor_style = v.to_string();
                }
                if let Some(v) = json.get("copy_on_select").and_then(|v| v.as_str()) {
                    config.terminal.copy_on_select = v != "false";
                }
                if let Some(v) = json.get("shell_integration").and_then(|v| v.as_str()) {
                    config.terminal.shell_integration = v != "false";
                }
                if let Some(v) = json.get("option_as_meta").and_then(|v| v.as_str()) {
                    config.terminal.option_as_meta = v != "false";
                }
            }
        }
    }

    save(&config)
}

// ─── File watcher ────────────────────────────────────────────────────────────

/// Spawn a background thread that watches ~/.koji-baseline/ for config changes.
/// On modification, debounces 100ms, reloads, and emits "config-changed" with the full config.
pub fn start_watcher(app: tauri::AppHandle) {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::sync::mpsc;

    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel::<Event>();

        let mut watcher = match notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[config] failed to create file watcher: {e}");
                return;
            }
        };

        let dir = config_dir();
        if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!("[config] failed to watch {}: {e}", dir.display());
            return;
        }

        let config_file = config_path();
        let mut last_reload = std::time::Instant::now();
        let debounce = std::time::Duration::from_millis(100);

        loop {
            match rx.recv() {
                Ok(event) => {
                    // Only care about modifications to our config file
                    let dominated = matches!(
                        event.kind,
                        EventKind::Modify(_) | EventKind::Create(_)
                    );
                    let is_config = event.paths.iter().any(|p| p == &config_file);

                    if dominated && is_config && last_reload.elapsed() >= debounce {
                        // Small sleep for debounce — editors often write in multiple steps
                        std::thread::sleep(debounce);
                        last_reload = std::time::Instant::now();

                        let config = load();
                        use tauri::Emitter;
                        let _ = app.emit("config-changed", &config);
                    }
                }
                Err(_) => break, // Channel closed, watcher dropped
            }
        }
    });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT_TOML: &str = include_str!("../../resources/default-config.toml");

    #[test]
    fn test_parse_default_config() {
        let config: KojiConfig = toml::from_str(DEFAULT_TOML).expect("default config should parse");
        assert_eq!(config.terminal.theme, "wallace");
        assert_eq!(config.terminal.font_size, 14);
        assert!(config.terminal.copy_on_select);
        assert!(config.notifications.enabled);
        assert_eq!(config.keybindings.new_tab, "cmd+t");
        assert_eq!(config.keybindings.split_down, "cmd+shift+d");
        // AI section
        assert!(config.ai.auto_diagnose);
        assert!(config.ai.suggest_enabled);
        assert_eq!(config.ai.suggest_debounce_ms, 500);
        assert!(config.ai.history_file);
        assert!(config.ai.blocks_enabled);
    }

    #[test]
    fn test_parse_empty_config() {
        let config: KojiConfig = toml::from_str("").expect("empty string should parse to defaults");
        assert_eq!(config.terminal.theme, "wallace");
        assert_eq!(config.terminal.font, "JetBrains Mono");
        assert_eq!(config.terminal.font_size, 14);
        assert!(config.terminal.shell_integration);
        assert!(config.notifications.enabled);
        assert_eq!(config.notifications.min_duration_seconds, 10);
        // AI defaults from empty config
        assert!(config.ai.auto_diagnose);
        assert!(config.ai.suggest_enabled);
        assert_eq!(config.ai.suggest_debounce_ms, 500);
        assert!(config.ai.history_file);
        assert!(config.ai.blocks_enabled);
    }

    #[test]
    fn test_parse_partial_config() {
        let partial = r#"
[terminal]
theme = "dracula"
font_size = 18
"#;
        let config: KojiConfig = toml::from_str(partial).expect("partial config should parse");
        assert_eq!(config.terminal.theme, "dracula");
        assert_eq!(config.terminal.font_size, 18);
        // Rest should be defaults
        assert_eq!(config.terminal.font, "JetBrains Mono");
        assert!(config.terminal.copy_on_select);
        assert!(config.notifications.enabled);
        assert_eq!(config.keybindings.new_tab, "cmd+t");
    }

    #[test]
    fn test_roundtrip() {
        let mut config = KojiConfig::default();
        config.terminal.theme = "monokai".into();
        config.terminal.font_size = 16;
        config.notifications.min_duration_seconds = 5;
        config.keybindings.new_tab = "ctrl+t".into();

        let serialized = toml::to_string_pretty(&config).expect("serialize should work");
        let deserialized: KojiConfig = toml::from_str(&serialized).expect("deserialize should work");

        assert_eq!(deserialized.terminal.theme, "monokai");
        assert_eq!(deserialized.terminal.font_size, 16);
        assert_eq!(deserialized.notifications.min_duration_seconds, 5);
        assert_eq!(deserialized.keybindings.new_tab, "ctrl+t");
        // Untouched fields should survive the trip
        assert_eq!(deserialized.terminal.font, "JetBrains Mono");
        assert!(deserialized.terminal.copy_on_select);
    }
}
