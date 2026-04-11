# Koji Baseline Batch D — Session Restore, Quick Terminal, Security, Performance

## Goal

Final polish batch: persist and restore sessions across app restarts, add a system-wide quick terminal (visor/dropdown), secure keyboard entry, performance profiling, and Unicode correctness verification.

## Scope

5 features:

1. **Session Restore** — save tab layout, pane CWDs, and scrollback on quit; restore on launch
2. **Quick Terminal (Visor)** — global hotkey drops terminal from screen edge
3. **Secure Keyboard Entry** — prevent other apps from intercepting keystrokes
4. **Performance Profiling** — measure render throughput, identify bottlenecks, optimize
5. **Unicode/Emoji Audit** — verify wide chars, ZWJ sequences, CJK alignment

## Non-Goals

- Full tmux session restore (we restore CWDs, not running processes)
- Kitty graphics protocol (separate future work)
- GPU/WebGL renderer (future — DOM renderer is sufficient for now)

---

## Architecture

### 1. Session Restore (`src-tauri/src/session_restore.rs` + `src/session/restore.ts`)

**Save on quit:** When the app closes (Tauri `on_window_event` + `CloseRequested`), serialize the current state:
- Tab order + active tab
- Per-tab: pane layout tree structure + CWD for each pane
- Window position and size
- Scrollback text (last 1000 lines per pane, compressed)

**Storage:** `~/.koji-baseline/session.json`

**Restore on launch:** Before creating the first tab, check for `session.json`. If present, recreate tabs and panes with saved CWDs. Scrollback is replayed as static text (not re-executed). After restore, delete the session file (single-use — prevents stale restores).

**Rust side:**
```rust
#[derive(Serialize, Deserialize)]
struct SavedSession {
    tabs: Vec<SavedTab>,
    active_tab_index: usize,
    window_x: f64,
    window_y: f64,
    window_width: f64,
    window_height: f64,
}

#[derive(Serialize, Deserialize)]
struct SavedTab {
    panes: Vec<SavedPane>,
    layout: SavedLayout,  // tree structure
}

#[derive(Serialize, Deserialize)]
struct SavedPane {
    cwd: String,
    scrollback: Vec<String>,  // last 1000 lines as plain text
}

#[derive(Serialize, Deserialize)]
enum SavedLayout {
    Leaf { pane_index: usize },
    Branch { direction: String, ratio: f64, first: Box<SavedLayout>, second: Box<SavedLayout> },
}
```

**Tauri commands:**
- `save_session(session: SavedSession)` — write to disk
- `load_session() -> Option<SavedSession>` — read + delete
- `clear_session()` — delete without reading

**Frontend restore flow:**
1. On boot, call `load_session()`
2. If session exists, skip normal first-tab creation
3. For each saved tab: create tab, for each pane split and set CWD
4. Replay scrollback as static text in the grid
5. Focus the previously-active tab

### 2. Quick Terminal / Visor (`src-tauri/src/quick_terminal.rs`)

A frameless, always-on-top window that slides down from the top of the screen on a global hotkey.

**Implementation via Tauri:**
- Register global shortcut via `tauri::plugin::global_shortcut`
- On trigger: if quick terminal window doesn't exist, create a new frameless window; if it exists and visible, hide it; if hidden, show it
- Window: frameless, transparent background, anchored to top of screen, 100% width, 40% height
- Slide animation via CSS transform
- The quick terminal has its own TabManager (separate from the main window)

**Config:**
```toml
[quick_terminal]
enabled = true
hotkey = "cmd+`"
height_percent = 40
position = "top"  # top, bottom
```

**Approach:** Use Tauri's multi-window API. The quick terminal is a second webview window with its own HTML entry point that loads a stripped-down version (no boot sequence, no dashboard — just terminal + tab bar).

Actually, simpler approach: use a SINGLE window with a CSS-based visor panel that slides in/out. This avoids multi-window complexity. The visor is a fixed-position div that covers the top portion of the screen.

**Simpler visor approach:**
- Add a `<div id="visor-panel">` to `index.html`, hidden by default
- On global hotkey, toggle visibility with slide animation
- The visor contains its own TabManager instance with separate tabs
- When visor is hidden, PTY sessions continue running

Actually, Tauri global shortcuts require the `global-shortcut` plugin. Let's use the simpler approach: register the hotkey in the keybinding system (Cmd+\`), toggle a visor overlay panel. This works without any Tauri plugins.

### 3. Secure Keyboard Entry

On macOS, secure keyboard entry prevents other applications from using the Carbon Event Manager to intercept keystrokes. This is important when typing passwords or SSH keys.

**Implementation:** Tauri doesn't expose this directly. We use a Rust FFI call to `EnableSecureEventInput()` / `DisableSecureEventInput()` from the Carbon framework.

```rust
#[cfg(target_os = "macos")]
extern "C" {
    fn EnableSecureEventInput();
    fn DisableSecureEventInput();
    fn IsSecureEventInputEnabled() -> bool;
}

#[tauri::command]
fn toggle_secure_input() -> bool {
    unsafe {
        if IsSecureEventInputEnabled() {
            DisableSecureEventInput();
            false
        } else {
            EnableSecureEventInput();
            true
        }
    }
}
```

**Frontend:** Add a lock icon to the status bar that toggles secure input. Visual indicator when active.

### 4. Performance Profiling

Not a feature — an audit task. Measure:
- DOMGrid `renderImmediate()` time for 200-col, 50-row viewport
- Memory at steady state with 10K scrollback lines
- Time to process `cat /dev/urandom | base64 | head -c 1000000`
- Frame rate during heavy output

**Optimizations to apply based on findings:**
- If render is slow: batch DOM mutations via `DocumentFragment`
- If memory is high: limit scrollback DOM nodes, virtualize
- If FPS drops: throttle render calls more aggressively

### 5. Unicode/Emoji Audit

Verify that alacritty_terminal + DOM renderer handle:
- Wide characters (CJK) occupy 2 cells
- Emoji modifiers (skin tones) render correctly
- ZWJ sequences (family emoji) render as single glyph
- Combining characters (accents) align properly

Fix any issues found. Most likely: column width calculation mismatches between Rust and DOM.

---

## File Changes (execution order)

| Order | File | Change | Est. lines |
|-------|------|--------|-----------|
| 1 | `src-tauri/src/session_restore.rs` (NEW) | Session save/load/clear commands | ~100 |
| 2 | `src-tauri/src/lib.rs` | Register commands, close handler | ~30 |
| 3 | `src/session/restore.ts` (NEW) | Frontend restore logic | ~120 |
| 4 | `src-tauri/src/config.rs` | Add [quick_terminal] config | ~20 |
| 5 | `src/visor/visor.ts` (NEW) | Quick terminal visor panel | ~100 |
| 6 | `src-tauri/src/lib.rs` | Secure input FFI commands | ~20 |
| 7 | `index.html` | Visor panel div, secure input indicator | ~5 |
| 8 | `src/main.ts` | Wire restore, visor keybinding, secure toggle | ~30 |
| 9 | `src/styles/wallace.css` | Visor styles, secure indicator | ~40 |
| 10 | `resources/default-config.toml` | Quick terminal config | ~10 |
| 11 | Performance audit (no files) | Measure + optimize | ~varies |
| 12 | Unicode audit (no files) | Verify + fix | ~varies |

**Estimated total: ~475 lines new/changed + audit findings**

---

## Testing Strategy

### Manual Test Checklist

Session Restore:
- [ ] Run 3 tabs with different CWDs, close app
- [ ] Reopen — all 3 tabs restored with correct CWDs
- [ ] Restored tabs have working shell prompts
- [ ] Split panes restore with correct layout
- [ ] Window position and size restored
- [ ] Session file deleted after restore (no stale restore on next launch)

Quick Terminal:
- [ ] Cmd+` toggles visor panel
- [ ] Visor slides down from top
- [ ] Visor has its own terminal session
- [ ] Main terminal continues working beneath visor
- [ ] Visor session persists across hide/show cycles
- [ ] Escape closes visor (returns to main terminal)

Secure Input:
- [ ] Click lock icon in status bar → secure input enabled
- [ ] Visual indicator shows lock is active
- [ ] Click again → disabled

Performance:
- [ ] `cat /dev/urandom | base64 | head -c 1M` completes without UI freeze
- [ ] Memory stays under 200MB with 10K scrollback
- [ ] No visible tearing during heavy output

Unicode:
- [ ] CJK characters (中文) align in 2-cell width
- [ ] Emoji (😀) renders correctly
- [ ] ZWJ sequences (👨‍👩‍👧‍👦) render as single glyph
- [ ] Combining characters (café) align properly
