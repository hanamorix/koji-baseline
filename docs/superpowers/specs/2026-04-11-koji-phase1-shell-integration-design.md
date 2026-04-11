# Koji Baseline Phase 1 — Shell Integration, OSC Support, Synchronized Rendering

## Goal

Add the foundational terminal features that every modern terminal has and that all future features (command blocks, AI suggestions, error diagnosis) depend on. Ship shell integration scripts that auto-inject, an event-driven architecture replacing VoidListener, and synchronized rendering.

## Scope

Three features, ordered by dependency:

1. **EventListener replacement** — swap VoidListener for KojiEventListener to capture Title, Clipboard (OSC 52), Bell, and PtyWrite events from alacritty_terminal
2. **Shell integration (OSC 7 + OSC 133)** — intercept raw PTY bytes for CWD tracking and semantic zone marking, auto-inject shell scripts
3. **Synchronized rendering (DCS mode 2026)** — respect alacritty_terminal's sync flag to prevent screen tearing

## Non-Goals

- Command blocks UI (Phase 3 — depends on OSC 133 zones working first)
- AI inline suggestions (Phase 3)
- Split panes (Phase 2)
- Kitty graphics protocol

---

## Architecture

### 1. KojiEventListener

Replace `VoidListener` with a custom `EventListener` that collects events into a thread-safe queue.

```rust
use std::sync::Arc;
use parking_lot::Mutex;
use alacritty_terminal::event::{Event, EventListener};

struct KojiEventListener {
    events: Arc<Mutex<Vec<Event>>>,
}

impl KojiEventListener {
    fn new() -> (Self, Arc<Mutex<Vec<Event>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        (Self { events: events.clone() }, events)
    }
}

impl EventListener for KojiEventListener {
    fn send_event(&self, event: Event) {
        self.events.lock().push(event);
    }
}
```

**Session struct changes:**
```rust
struct Session {
    pty: PtyManager,
    engine: TerminalEngine,  // now wraps Term<KojiEventListener>
    events: Arc<Mutex<Vec<Event>>>,  // shared with the listener inside Term
}
```

**Events handled in the I/O thread drain loop:**

| Event | Action |
|-------|--------|
| `Title(s)` | Emit `title-changed-{tab_id}` to frontend |
| `ClipboardStore(_, text)` | Emit `clipboard-store-{tab_id}` — frontend writes to system clipboard |
| `ClipboardLoad(_, formatter)` | Emit `clipboard-load-{tab_id}` — frontend reads clipboard, sends formatted response back via `write_to_session` |
| `Bell` | Emit `terminal-bell-{tab_id}` (replaces manual `check_bell()` byte scanning) |
| `PtyWrite(text)` | Write directly to PTY (response sequences from terminal) |

### 2. OSC Byte Scanner (`osc.rs`)

A stateless scanner that inspects raw PTY bytes for OSC sequences that alacritty_terminal ignores. Runs before `parser.advance()` in the I/O thread.

**Sequences intercepted:**

| OSC | Format | Data extracted |
|-----|--------|----------------|
| OSC 7 | `\x1b]7;file://host/path\x07` | Working directory path |
| OSC 133;A | `\x1b]133;A\x07` | Prompt start (line number) |
| OSC 133;B | `\x1b]133;B\x07` | Input start (line number) |
| OSC 133;C | `\x1b]133;C\x07` | Output start (line number) |
| OSC 133;D;N | `\x1b]133;D;N\x07` | Command end + exit code |

**Scanner API:**

```rust
pub struct OscEvent {
    pub kind: OscEventKind,
}

pub enum OscEventKind {
    WorkingDirectory(String),
    PromptStart,
    InputStart,
    OutputStart,
    CommandEnd { exit_code: Option<i32> },
}

/// Scan a byte buffer for OSC 7 and OSC 133 sequences.
/// Returns extracted events. Does NOT modify the buffer — bytes still
/// pass through to alacritty_terminal for full VTE processing.
pub fn scan_osc(bytes: &[u8]) -> Vec<OscEvent>
```

**Handling partial sequences across read boundaries:**

The scanner maintains no state between calls. OSC sequences are short (< 256 bytes) and almost always arrive in a single PTY read. If a sequence is split across reads, it's missed — this is acceptable because:
- The next `precmd` will re-emit OSC 7 (CWD self-corrects every prompt)
- OSC 133 markers are emitted at prompt boundaries where output is low-throughput
- This matches how WezTerm and Ghostty handle it

If this proves unreliable in practice, we add a small carryover buffer in a future pass.

### 3. Command Zones

Stored per-session in Rust. Updated by OSC 133 markers.

```rust
struct CommandZone {
    prompt_line: usize,
    input_line: Option<usize>,
    output_line: Option<usize>,
    end_line: Option<usize>,
    exit_code: Option<i32>,
    start_time: u64,      // ms since epoch, set at C marker
    end_time: Option<u64>, // ms since epoch, set at D marker
}
```

**Zone lifecycle:**
1. `A` marker → push new zone with `prompt_line` set
2. `B` marker → set `input_line` on current zone
3. `C` marker → set `output_line` and `start_time`
4. `D` marker → set `end_line`, `exit_code`, `end_time`

Zones are stored as `Vec<CommandZone>` on the session. When history is trimmed, zones referencing removed lines are dropped.

**Frontend receives zones** as a new field on the Tauri event payload (not GridSnapshot — zones change less frequently than the grid). Emitted as `zones-update-{tab_id}` when a zone is created or completed.

### 4. Shell Integration Scripts

Three scripts, shipped in the app bundle under `resources/shell-integration/`.

#### Auto-Injection Mechanism

The PTY spawner (`pty.rs`) detects the shell and sets up injection:

**For zsh:**
- Create a temp ZDOTDIR containing a `.zshenv` that:
  1. Restores real `ZDOTDIR` (or `$HOME`)
  2. Sources the real `.zshenv` if it exists
  3. Sources `koji.zsh`
- Set `ZDOTDIR` to the temp dir, set `KOJI_ORIG_ZDOTDIR` to preserve the original

**For bash:**
- Set `KOJI_BASH_INTEGRATION=$DIR/koji.bash`
- Use `--rcfile` pointing to a wrapper script that sources `~/.bashrc` then sources `koji.bash`

**For fish:**
- Set `XDG_DATA_DIRS` to include `$DIR/fish-vendor/` which contains `fish/vendor_conf.d/koji.fish`
- Fish auto-sources vendor conf.d files

**Environment variables set for all shells:**
- `KOJI_SHELL_INTEGRATION=1` — guard variable, scripts check this
- `KOJI_SHELL_INTEGRATION_DIR=/path/to/scripts` — where scripts live
- `TERM_PROGRAM=koji-baseline` — identifies the terminal to shell scripts
- `TERM_PROGRAM_VERSION=0.7.0` — version for compatibility checks

**Disable mechanism:**
- Config key `shell_integration` (default: `true`)
- `/shell-integration off` slash command sets it to false, takes effect on next tab
- `/shell-integration on` re-enables
- When disabled, none of the ZDOTDIR/rcfile/XDG overrides are applied

#### koji.zsh (~35 lines)

```zsh
[[ -n "$KOJI_SHELL_INTEGRATION" ]] || return 0

# Restore original ZDOTDIR
[[ -n "$KOJI_ORIG_ZDOTDIR" ]] && ZDOTDIR="$KOJI_ORIG_ZDOTDIR"
unset KOJI_ORIG_ZDOTDIR

# OSC 133 + OSC 7 via precmd/preexec hooks
_koji_precmd() {
    local ec=$?
    # D marker — previous command finished (skip on first prompt)
    [[ -n "$_koji_cmd_started" ]] && printf '\e]133;D;%d\a' "$ec"
    _koji_cmd_started=
    # OSC 7 — working directory
    printf '\e]7;file://%s%s\a' "${HOST:-$(hostname)}" "$PWD"
    # A marker — prompt start
    printf '\e]133;A\a'
}

_koji_preexec() {
    _koji_cmd_started=1
    # C marker — output start
    printf '\e]133;C\a'
}

# B marker — input start (after prompt rendered)
_koji_zle_line_init() { printf '\e]133;B\a'; }

autoload -Uz add-zsh-hook
add-zsh-hook precmd _koji_precmd
add-zsh-hook preexec _koji_preexec
zle -N zle-line-init _koji_zle_line_init
```

#### koji.bash (~30 lines)

```bash
[[ -n "$KOJI_SHELL_INTEGRATION" ]] || return 0

_koji_cmd_started=
_koji_prompt_command() {
    local ec=$?
    [[ -n "$_koji_cmd_started" ]] && printf '\e]133;D;%d\a' "$ec"
    _koji_cmd_started=
    printf '\e]7;file://%s%s\a' "$(hostname)" "$PWD"
    printf '\e]133;A\a'
}

_koji_preexec() {
    _koji_cmd_started=1
    printf '\e]133;C\a'
}

PROMPT_COMMAND="_koji_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '_koji_preexec' DEBUG

# B marker after prompt
PS1="${PS1}\[\e]133;B\a\]"
```

#### koji.fish (~25 lines)

```fish
test -n "$KOJI_SHELL_INTEGRATION"; or exit 0

set -g _koji_cmd_started ""

function _koji_prompt --on-event fish_prompt
    set -l ec $status
    test -n "$_koji_cmd_started"; and printf '\e]133;D;%d\a' $ec
    set -g _koji_cmd_started ""
    printf '\e]7;file://%s%s\a' (hostname) "$PWD"
    printf '\e]133;A\a'
    printf '\e]133;B\a'
end

function _koji_preexec --on-event fish_preexec
    set -g _koji_cmd_started "1"
    printf '\e]133;C\a'
end
```

### 5. Synchronized Rendering

**In the I/O thread**, after `process_bytes()`, check if we're in a synchronized update:

```rust
// Only emit snapshot when not in synchronized update
let sync_pending = parser.sync_bytes_count() > 0;
if !sync_pending {
    let snap = session.engine.snapshot();
    app_handle.emit(&ev_output, &snap);
}
```

**Timeout safety:** If a sync sequence opens but never closes (broken app), the I/O thread would never emit. Add a 100ms timeout: if sync has been pending for > 100ms, force-emit and reset.

**API caveat:** `alacritty_terminal`'s `Processor::sync_bytes_count()` is used internally by its event loop but may not be public. If the API is not accessible, we implement sync detection ourselves by scanning for DCS mode 2026 sequences (`\x1bP=1s\x1b\\` to start, `\x1bP=2s\x1b\\` to end) in the OSC scanner — same pattern as OSC 7/133 interception. This is a minor fallback that doesn't affect the design.

### 6. Frontend Changes

#### tab-session.ts

New event listeners in `start()`:

```typescript
// CWD from OSC 7
const cwdUn = await listen<{ path: string }>(`cwd-update-${this.id}`, (event) => {
    this._cwd = event.payload.path;
    this._onCwdChanged?.(event.payload.path);
});

// Title from OSC 0/1/2
const titleUn = await listen<string>(`title-changed-${this.id}`, (event) => {
    document.title = event.payload;
});

// Clipboard store from OSC 52
const clipUn = await listen<string>(`clipboard-store-${this.id}`, (event) => {
    navigator.clipboard.writeText(event.payload).catch(console.warn);
});

// Zones from OSC 133
const zonesUn = await listen<CommandZone[]>(`zones-update-${this.id}`, (event) => {
    this._zones = event.payload;
});
```

New property: `cwd` (string) — used by TabManager when creating new tabs.

#### tab-manager.ts

When creating a new tab, pass the active tab's CWD:

```typescript
const currentCwd = this.getActive()?.cwd;
// ... in session.start():
await invoke("create_session", { tabId: id, rows, cols, cwd: currentCwd });
```

#### zones.ts (NEW)

Handles Cmd+Up / Cmd+Down navigation:

```typescript
export function jumpToZone(
    grid: DOMGrid,
    zones: CommandZone[],
    direction: "up" | "down",
    currentLine: number
): number | null
```

Finds the nearest zone prompt_line in the given direction and scrolls the grid to it.

#### main.ts

Wire Cmd+Up / Cmd+Down:

```typescript
if (metaKey && key === "ArrowUp") {
    event.preventDefault();
    // Jump to previous prompt
    tab.jumpToPreviousZone();
    return;
}
if (metaKey && key === "ArrowDown") {
    event.preventDefault();
    // Jump to next prompt
    tab.jumpToNextZone();
    return;
}
```

Add `/shell-integration` slash command.

#### Dashboard CWD

The `cwd-changed` event from `monitor.rs` continues to work as fallback for shells without integration. When OSC 7 events arrive, they take priority (more immediate, no polling delay).

---

## Testing Strategy

### Rust Unit Tests

**osc.rs tests:**
- `test_scan_osc7_valid` — standard `file://host/path` URL
- `test_scan_osc7_no_host` — `file:///path` (some shells omit hostname)
- `test_scan_osc7_spaces_in_path` — URL-encoded spaces
- `test_scan_osc7_empty` — no OSC sequences in buffer
- `test_scan_osc7_st_terminator` — `\x1b\\` instead of `\x07`
- `test_scan_osc133_all_markers` — A, B, C, D markers
- `test_scan_osc133_d_with_exit_code` — `D;0`, `D;1`, `D;127`
- `test_scan_osc133_d_without_exit_code` — just `D`
- `test_scan_mixed_osc` — buffer with both OSC 7 and OSC 133
- `test_scan_osc_partial_sequence` — truncated sequence returns empty
- `test_scan_osc_in_normal_output` — no false positives in `ls` output
- `test_scan_osc_malformed` — garbage after `\x1b]` doesn't panic

**terminal.rs tests:**
- `test_koji_event_listener_collects_events` — events are queued
- `test_koji_event_listener_drain` — drain returns and clears
- `test_command_zone_lifecycle` — A→B→C→D creates complete zone
- `test_command_zone_missing_markers` — partial zones handled gracefully
- `test_command_zone_overlapping` — new A before D closes previous zone

### Integration Tests

- `test_pty_shell_integration_zsh` — spawn zsh with integration, type `cd /tmp`, verify OSC 7 emitted
- `test_pty_shell_integration_disabled` — config off, verify no injection
- `test_pty_osc52_clipboard_roundtrip` — write OSC 52 to PTY, verify ClipboardStore event
- `test_pty_new_tab_inherits_cwd` — create session with CWD, verify shell starts there

### Frontend Tests (Manual Checklist)

- [ ] First tab shows correct CWD in tab name after first prompt
- [ ] `cd /tmp` updates tab name to "tmp"
- [ ] Cmd+T opens new tab in same CWD as current tab
- [ ] Cmd+Up jumps to previous prompt
- [ ] Cmd+Down jumps to next prompt
- [ ] OSC 52 copy from vim-over-SSH works
- [ ] `/shell-integration off` → new tab has no zone markers
- [ ] `/shell-integration on` → new tab has zone markers
- [ ] Heavy output (cat large file) doesn't tear (sync rendering)
- [ ] Window title updates from OSC 0/1/2
- [ ] Failed command (exit code != 0) shows red indicator on zone

---

## Config Changes

New keys in `~/.koji-baseline/config.json`:

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `shell_integration` | bool | `true` | Enable/disable auto-injection |

---

## File Changes

| File | Change | Lines est. |
|------|--------|-----------|
| `src-tauri/src/osc.rs` | **NEW** — OSC 7/133 scanner | ~120 |
| `src-tauri/src/terminal.rs` | KojiEventListener, Term<KojiEventListener>, zone tracking | ~80 |
| `src-tauri/src/lib.rs` | Event drain in I/O thread, new Tauri events, sync check, CWD passing | ~60 |
| `src-tauri/src/pty.rs` | Shell detection, env injection, ZDOTDIR/rcfile setup | ~80 |
| `src/tabs/tab-session.ts` | New event listeners, cwd property, zone storage | ~40 |
| `src/tabs/tab-manager.ts` | CWD inheritance on new tab | ~10 |
| `src/terminal/zones.ts` | **NEW** — zone navigation (Cmd+Up/Down) | ~60 |
| `src/main.ts` | Wire shortcuts, /shell-integration command | ~20 |
| `src/commands/handlers.ts` | /shell-integration handler | ~15 |
| `resources/shell-integration/koji.zsh` | **NEW** — zsh integration | ~35 |
| `resources/shell-integration/koji.bash` | **NEW** — bash integration | ~30 |
| `resources/shell-integration/koji.fish` | **NEW** — fish integration | ~25 |
| `resources/shell-integration/zdotdir/.zshenv` | **NEW** — ZDOTDIR wrapper | ~10 |
| Tests across osc.rs, terminal.rs | ~20 test functions | ~200 |

**Estimated total: ~785 lines of new/changed code + ~200 lines of tests.**
