# Koji Baseline Batch A — Config Infrastructure, Command Palette, Notifications

## Goal

Add the infrastructure layer that every subsequent feature depends on: a TOML config file with hot reload, configurable keybindings, a command palette, and long-running command notifications. Also verify tmux/SSH compatibility.

## Scope

6 features, ordered by dependency:

1. **TOML config file + hot reload** — portable, version-controllable config replacing JSON for user preferences
2. **Configurable keybindings** — action map driven by config, replaces hardcoded if/else chains
3. **Command palette (Cmd+Shift+P)** — fuzzy-filtered action list with keybinding hints
4. **Long-running command notifications** — macOS notification when backgrounded command finishes
5. **tmux compatibility** — /terminfo command with tmux tips
6. **SSH terminfo** — verification that xterm-256color works universally

## Non-Goals

- Split panes (Batch B)
- Command blocks UI (Batch C)
- Session restore (Batch D)
- Custom TERM value / shipping terminfo entries (xterm-256color is sufficient)

---

## Architecture

### 1. TOML Config System (`config.rs`)

New Rust module: `src-tauri/src/config.rs`

**Config file location:** `~/.koji-baseline/config.toml`

**Default config template:** Shipped in `resources/default-config.toml`, copied on first launch if no config exists.

**Structure:**

```toml
[terminal]
theme = "wallace"
font = "JetBrains Mono"
font_size = 14
cursor_style = "block"
copy_on_select = true
shell_integration = true
option_as_meta = true

[notifications]
enabled = true
min_duration_seconds = 10

[keybindings]
new_tab = "cmd+t"
close_tab = "cmd+w"
next_tab = "cmd+shift+]"
prev_tab = "cmd+shift+["
search = "cmd+f"
clear = "cmd+k"
palette = "cmd+shift+p"
zone_up = "cmd+up"
zone_down = "cmd+down"
font_up = "cmd+="
font_down = "cmd+-"
font_reset = "cmd+0"
select_all = "cmd+a"
copy = "cmd+c"
paste = "cmd+v"
split_right = "cmd+d"
split_down = "cmd+shift+d"
```

**Rust types:**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KojiConfig {
    #[serde(default)]
    pub terminal: TerminalConfig,
    #[serde(default)]
    pub notifications: NotificationConfig,
    #[serde(default)]
    pub keybindings: KeybindingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_cursor")]
    pub cursor_style: String,
    #[serde(default = "default_true")]
    pub copy_on_select: bool,
    #[serde(default = "default_true")]
    pub shell_integration: bool,
    #[serde(default = "default_true")]
    pub option_as_meta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_min_duration")]
    pub min_duration_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeybindingConfig {
    #[serde(default = "default_new_tab")]
    pub new_tab: String,
    #[serde(default = "default_close_tab")]
    pub close_tab: String,
    // ... all keybindings with defaults matching current hardcoded shortcuts
}
```

**Tauri commands:**

```rust
#[tauri::command]
fn load_toml_config() -> Result<KojiConfig, String>

#[tauri::command]
fn save_toml_config(config: KojiConfig) -> Result<(), String>

#[tauri::command]  
fn get_config_path() -> String
```

**File watcher:** On app startup, spawn a thread using the `notify` crate to watch `config.toml`. On modification, re-parse and emit `config-changed` Tauri event with the full config. Frontend reloads affected settings (theme, font, keybindings).

**Migration from JSON:** On first load, if `config.toml` doesn't exist but `config.json` does, read the JSON values and write a `config.toml` with those values merged over defaults. The JSON file continues to store runtime state (activeModel, autorun) that isn't user-configurable.

**Backward compatibility:** The existing `save_config`/`load_config` commands for JSON continue to work for runtime state. TOML is for user preferences only. The `shell_integration` key currently in JSON is migrated to TOML.

### 2. Configurable Keybindings (`src/config/keybindings.ts`)

New TypeScript module that parses keybinding strings and dispatches actions.

**Key combo format:** `"cmd+shift+p"`, `"cmd+t"`, `"cmd+1"` — matches common terminal config syntax.

**Parser:**

```typescript
interface KeyCombo {
  key: string;       // lowercase: "t", "p", "]", "arrowup"
  cmd: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

function parseKeyCombo(combo: string): KeyCombo
function matchesEvent(combo: KeyCombo, event: KeyboardEvent): boolean
```

**Action registry:**

```typescript
type ActionHandler = () => void | Promise<void>;

class KeybindingManager {
  private bindings: Map<string, { combo: KeyCombo; action: ActionHandler }>;
  
  loadFromConfig(config: KeybindingConfig): void
  register(action: string, handler: ActionHandler): void
  handleKeyEvent(event: KeyboardEvent): boolean  // returns true if handled
}
```

**Integration with main.ts:** The current ~100 lines of hardcoded `if (metaKey && key === "t")` chains are replaced with:

```typescript
const keybindings = new KeybindingManager();
keybindings.register("new_tab", () => tabManager.createTab().catch(console.error));
keybindings.register("close_tab", () => tabManager.closeActiveTab());
// ... etc

window.addEventListener("keydown", (event) => {
  // Skip if input focused
  if (active?.tagName === "INPUT" || active?.tagName === "TEXTAREA") return;
  
  if (keybindings.handleKeyEvent(event)) return;
  
  // Remaining logic: autocomplete nav, input tracking, keyToAnsi
});
```

The action names match the TOML config keys exactly.

### 3. Command Palette (`src/config/palette.ts`)

A centered overlay that lists all actions + slash commands with fuzzy filtering.

**UI structure:**
```
┌─────────────────────────────────────┐
│ > [filter input________________]    │
├─────────────────────────────────────┤
│ New Tab                    Cmd+T    │
│ Close Tab                  Cmd+W    │
│ Search                     Cmd+F    │
│ Command Palette         Cmd+Shift+P │
│ ─────────────────────────────────── │
│ /theme — Open theme picker          │
│ /font — Change terminal font        │
│ /shell-integration — Toggle hooks   │
│ ...                                 │
└─────────────────────────────────────┘
```

**Implementation:** Reuses the `InteractiveMenu` pattern but with dedicated CSS. The palette is a singleton triggered by the `palette` keybinding action. Items are:
1. All registered keybinding actions (with their current key combo displayed)
2. All slash commands from the /help menu (with descriptions)

**Fuzzy filtering:** Simple substring match on label + description. Highlight matched characters.

**Execution:** Selecting an action runs it immediately. Selecting a slash command dispatches it through the command router.

**CSS:** Centered modal, 500px wide, max-height 400px, scrollable list. Uses theme CSS variables.

### 4. Long-Running Command Notifications

**Rust-side logic** in the I/O thread, triggered when a zone completes (OSC 133 D marker):

```rust
// After zone completion is detected:
if notification_enabled && zone.end_time - zone.start_time > min_duration_ms {
    // Check if window is focused
    let focused = app_handle.get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(true))
        .unwrap_or(true);
    
    if !focused {
        let _ = app_handle.emit("notify-command-complete", serde_json::json!({
            "tab_id": thread_tab_id,
            "exit_code": zone.exit_code,
            "duration_seconds": (zone.end_time - zone.start_time) / 1000,
        }));
    }
}
```

**Frontend handler:** Listens for `notify-command-complete` and uses the browser Notification API (allowed by CSP with `'self'`):

```typescript
listen("notify-command-complete", (event) => {
  const { exit_code, duration_seconds } = event.payload;
  const status = exit_code === 0 ? "completed" : `failed (exit ${exit_code})`;
  new Notification("Kōji Baseline", {
    body: `Command ${status} after ${duration_seconds}s`,
  });
});
```

**Config:** Read `notifications.enabled` and `notifications.min_duration_seconds` from TOML config.

### 5. tmux Compatibility

**No code changes needed** — we use `xterm-256color` which is the correct value.

**Add `/terminfo` slash command** that displays:
```
TERM: xterm-256color
COLORTERM: truecolor

tmux tip: Add to ~/.tmux.conf:
  set -g default-terminal "tmux-256color"
  set -ga terminal-overrides ",xterm-256color:Tc"

ssh tip: TERM is forwarded automatically. If colors break:
  export TERM=xterm-256color
```

### 6. SSH Terminfo

**Verification only** — `xterm-256color` is installed on every Linux/macOS system. No code changes. The `/terminfo` command covers the documentation.

---

## File Changes (execution order — minimizes jumping)

| Order | File | Change | Est. lines |
|-------|------|--------|-----------|
| 1 | `Cargo.toml` | Add `toml = "0.8"`, `notify = "7"` | 2 |
| 2 | `src-tauri/src/config.rs` (NEW) | TOML types, parse, save, watcher, migration | ~200 |
| 3 | `src-tauri/src/lib.rs` | Register config commands, notification emit in I/O thread | ~40 |
| 4 | `resources/default-config.toml` (NEW) | Default config template | ~30 |
| 5 | `src/config/keybindings.ts` (NEW) | Key combo parser, action registry, manager | ~120 |
| 6 | `src/config/palette.ts` (NEW) | Command palette UI + fuzzy filter | ~150 |
| 7 | `src/main.ts` | Replace hardcoded shortcuts with keybinding dispatch | ~-80/+40 (net reduction) |
| 8 | `src/commands/handlers.ts` | Add /terminfo, update /help | ~20 |
| 9 | `src/commands/router.ts` | Wire /terminfo | ~3 |
| 10 | `src/styles/wallace.css` | Palette modal styles | ~40 |
| 11 | Tests (config.rs) | TOML parse, defaults, migration, keybinding parse | ~100 |

**Estimated total: ~745 lines new/changed + ~100 lines tests**

---

## Testing Strategy

### Rust Unit Tests (config.rs)

- `test_parse_default_config` — parse the default TOML, all fields populated
- `test_parse_empty_config` — empty file gets all defaults
- `test_parse_partial_config` — only `[terminal]` section, rest defaults
- `test_parse_keybinding_format` — various key combo strings are valid
- `test_migration_from_json` — JSON values correctly map to TOML structure
- `test_invalid_toml_returns_error` — malformed TOML gives clear error

### Frontend Tests (manual checklist)

- [ ] App launches with no config.toml — creates one from defaults
- [ ] Edit config.toml, save — settings reload without restart
- [ ] Change `theme = "neon"` in TOML — theme switches live
- [ ] Change `keybindings.new_tab = "cmd+shift+t"` — old Cmd+T stops working, new binding works
- [ ] Cmd+Shift+P opens command palette
- [ ] Type in palette filters actions
- [ ] Select action from palette executes it
- [ ] Long command (sleep 15) in background tab → macOS notification appears
- [ ] /terminfo shows correct TERM value and tips
- [ ] Existing JSON config values (activeModel) still work
