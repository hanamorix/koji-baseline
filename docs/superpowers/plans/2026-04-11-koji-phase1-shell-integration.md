# Phase 1: Shell Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add EventListener-driven OSC support (titles, clipboard, bell), shell integration scripts with auto-injection (OSC 7 CWD + OSC 133 semantic zones), and synchronized rendering.

**Architecture:** Replace VoidListener with KojiEventListener to capture alacritty_terminal events. Add a stateless OSC byte scanner for OSC 7/133 sequences that alacritty ignores. Auto-inject shell scripts via ZDOTDIR (zsh), --rcfile (bash), and XDG_DATA_DIRS (fish). Zone data flows from Rust → Tauri events → TypeScript for Cmd+Up/Down navigation.

**Tech Stack:** Rust (alacritty_terminal 0.25.1, parking_lot, portable-pty), TypeScript (Tauri v2 IPC), shell scripts (zsh/bash/fish)

---

### Task 1: OSC Byte Scanner — Tests + Implementation

**Files:**
- Create: `src-tauri/src/osc.rs`

- [ ] **Step 1: Create `osc.rs` with types and `scan_osc` function + full test suite**

```rust
// osc.rs — Stateless scanner for OSC 7 (CWD) and OSC 133 (semantic zones)
// Runs on raw PTY bytes BEFORE alacritty_terminal processes them.
// Does NOT modify the buffer — bytes still pass through for full VTE processing.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum OscEventKind {
    WorkingDirectory(String),
    PromptStart,
    InputStart,
    OutputStart,
    CommandEnd { exit_code: Option<i32> },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OscEvent {
    pub kind: OscEventKind,
}

/// Scan a byte buffer for OSC 7 and OSC 133 sequences.
/// Returns extracted events. The buffer is not modified.
pub fn scan_osc(bytes: &[u8]) -> Vec<OscEvent> {
    let mut events = Vec::new();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Look for ESC ] (0x1b 0x5d) — OSC introducer
        if bytes[i] == 0x1b && i + 1 < len && bytes[i + 1] == 0x5d {
            if let Some((event, end)) = parse_osc(&bytes[i + 2..]) {
                events.push(event);
                i += 2 + end;
                continue;
            }
        }
        i += 1;
    }

    events
}

/// Parse an OSC payload starting after the `ESC ]` introducer.
/// Returns the event and the number of bytes consumed (including terminator).
fn parse_osc(data: &[u8]) -> Option<(OscEvent, usize)> {
    // Find terminator: BEL (0x07) or ST (ESC \)
    let mut end = None;
    let mut term_len = 0;
    for i in 0..data.len() {
        if data[i] == 0x07 {
            end = Some(i);
            term_len = 1;
            break;
        }
        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == 0x5c {
            end = Some(i);
            term_len = 2;
            break;
        }
    }

    let end_idx = end?;
    let payload = &data[..end_idx];

    // OSC 7 — file://host/path
    if payload.starts_with(b"7;") {
        let url_bytes = &payload[2..];
        let url = std::str::from_utf8(url_bytes).ok()?;
        let path = parse_file_url(url)?;
        return Some((
            OscEvent { kind: OscEventKind::WorkingDirectory(path) },
            end_idx + term_len,
        ));
    }

    // OSC 133 — semantic zones
    if payload.starts_with(b"133;") {
        let marker = &payload[4..];
        let kind = match marker {
            b"A" => Some(OscEventKind::PromptStart),
            b"B" => Some(OscEventKind::InputStart),
            b"C" => Some(OscEventKind::OutputStart),
            _ if marker.starts_with(b"D") => {
                let exit_code = if marker.len() > 2 && marker[1] == b';' {
                    std::str::from_utf8(&marker[2..]).ok()
                        .and_then(|s| s.parse::<i32>().ok())
                } else {
                    None
                };
                Some(OscEventKind::CommandEnd { exit_code })
            }
            _ => None,
        };
        if let Some(k) = kind {
            return Some((OscEvent { kind: k }, end_idx + term_len));
        }
    }

    None
}

/// Extract the path from a file:// URL.
/// Handles: file://hostname/path, file:///path, file:///path%20with%20spaces
fn parse_file_url(url: &str) -> Option<String> {
    let stripped = url.strip_prefix("file://")?;
    // Skip hostname: everything up to the first / after the //
    let path = if stripped.starts_with('/') {
        stripped // no hostname, e.g. file:///path
    } else {
        // hostname/path — skip to first /
        stripped.find('/').map(|i| &stripped[i..])?
    };
    // Percent-decode the path
    Some(percent_decode(path))
}

fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                result.push(hex as char);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i] as char);
        i += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_osc7_valid() {
        let bytes = b"\x1b]7;file://myhost/Users/hana/projects\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::WorkingDirectory("/Users/hana/projects".to_string()));
    }

    #[test]
    fn test_scan_osc7_no_host() {
        let bytes = b"\x1b]7;file:///tmp\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::WorkingDirectory("/tmp".to_string()));
    }

    #[test]
    fn test_scan_osc7_spaces_in_path() {
        let bytes = b"\x1b]7;file://host/Users/hana/my%20project\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::WorkingDirectory("/Users/hana/my project".to_string()));
    }

    #[test]
    fn test_scan_osc7_empty_buffer() {
        let events = scan_osc(b"hello world\n");
        assert!(events.is_empty());
    }

    #[test]
    fn test_scan_osc7_st_terminator() {
        let bytes = b"\x1b]7;file://host/tmp\x1b\\";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::WorkingDirectory("/tmp".to_string()));
    }

    #[test]
    fn test_scan_osc133_all_markers() {
        let bytes = b"\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 4);
        assert_eq!(events[0].kind, OscEventKind::PromptStart);
        assert_eq!(events[1].kind, OscEventKind::InputStart);
        assert_eq!(events[2].kind, OscEventKind::OutputStart);
        assert_eq!(events[3].kind, OscEventKind::CommandEnd { exit_code: Some(0) });
    }

    #[test]
    fn test_scan_osc133_d_with_exit_codes() {
        let b1 = b"\x1b]133;D;1\x07";
        let b2 = b"\x1b]133;D;127\x07";
        assert_eq!(scan_osc(b1)[0].kind, OscEventKind::CommandEnd { exit_code: Some(1) });
        assert_eq!(scan_osc(b2)[0].kind, OscEventKind::CommandEnd { exit_code: Some(127) });
    }

    #[test]
    fn test_scan_osc133_d_without_exit_code() {
        let bytes = b"\x1b]133;D\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, OscEventKind::CommandEnd { exit_code: None });
    }

    #[test]
    fn test_scan_mixed_osc() {
        let bytes = b"some output\x1b]133;A\x07prompt$ \x1b]133;B\x07\x1b]7;file://h/tmp\x07";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].kind, OscEventKind::PromptStart);
        assert_eq!(events[1].kind, OscEventKind::InputStart);
        assert_eq!(events[2].kind, OscEventKind::WorkingDirectory("/tmp".to_string()));
    }

    #[test]
    fn test_scan_osc_partial_sequence() {
        // Truncated — no terminator
        let bytes = b"\x1b]7;file://host/tmp";
        let events = scan_osc(bytes);
        assert!(events.is_empty());
    }

    #[test]
    fn test_scan_osc_in_normal_output() {
        let bytes = b"total 48\ndrwxr-xr-x  12 user  staff  384 Apr 11 02:00 .\n";
        let events = scan_osc(bytes);
        assert!(events.is_empty());
    }

    #[test]
    fn test_scan_osc_malformed() {
        let bytes = b"\x1b]999;garbage\x07\x1b];\x07\x1b]\x07";
        let events = scan_osc(bytes);
        assert!(events.is_empty()); // no panics, no events
    }
}
```

- [ ] **Step 2: Register the module in `lib.rs`**

Add `pub mod osc;` to the module declarations at the top of `src-tauri/src/lib.rs` (after `pub mod terminal;`).

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd src-tauri && cargo test osc -- --nocapture`
Expected: All 11 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/osc.rs src-tauri/src/lib.rs
git commit -m "feat: OSC 7/133 byte scanner with full test suite"
```

---

### Task 2: KojiEventListener + TerminalEngine Generics

**Files:**
- Modify: `src-tauri/src/terminal.rs`

- [ ] **Step 1: Add KojiEventListener and make TerminalEngine generic**

Replace the TerminalEngine struct and its `new()` to use `KojiEventListener` instead of `VoidListener`. Add the listener type, zone tracking struct, and update the constructor.

In `terminal.rs`, replace the imports at line 4-5:

```rust
use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
```

with:

```rust
use alacritty_terminal::Term;
use alacritty_terminal::event::{Event, EventListener};
use std::sync::Arc;
use parking_lot::Mutex as PlMutex;
```

Add the KojiEventListener and CommandZone structs before the TerminalEngine struct (before line 193):

```rust
// ─── KojiEventListener ──────────────────────────────────────────────────────

/// Collects alacritty_terminal events into a shared queue.
/// Replaces VoidListener so we can capture Title, Clipboard, Bell, PtyWrite.
#[derive(Clone)]
pub struct KojiEventListener {
    events: Arc<PlMutex<Vec<Event>>>,
}

impl KojiEventListener {
    pub fn new() -> (Self, Arc<PlMutex<Vec<Event>>>) {
        let events = Arc::new(PlMutex::new(Vec::new()));
        (Self { events: events.clone() }, events)
    }
}

impl EventListener for KojiEventListener {
    fn send_event(&self, event: Event) {
        self.events.lock().push(event);
    }
}

// ─── Command Zones ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandZone {
    pub prompt_line: usize,
    pub input_line: Option<usize>,
    pub output_line: Option<usize>,
    pub end_line: Option<usize>,
    pub exit_code: Option<i32>,
    pub start_time: u64,
    pub end_time: Option<u64>,
}
```

Then replace the TerminalEngine struct definition and `new()` method. Change:

```rust
pub struct TerminalEngine {
    term: Term<VoidListener>,
    parser: Processor,
    rows: usize,
    cols: usize,
    pub color_overrides: HashMap<String, [u8; 3]>,
    prev_history_len: usize,
}

impl TerminalEngine {
    pub fn new(rows: usize, cols: usize) -> Self {
        let size = TermSize::new(cols, rows);
        let config = TermConfig::default();
        let term = Term::new(config, &size, VoidListener);
        let parser = Processor::new();

        Self { term, parser, rows, cols, color_overrides: HashMap::new(), prev_history_len: 0 }
    }
```

to:

```rust
pub struct TerminalEngine {
    term: Term<KojiEventListener>,
    parser: Processor,
    rows: usize,
    cols: usize,
    pub color_overrides: HashMap<String, [u8; 3]>,
    prev_history_len: usize,
    pub zones: Vec<CommandZone>,
    pub cwd: Option<String>,
}

impl TerminalEngine {
    pub fn new(rows: usize, cols: usize) -> (Self, Arc<PlMutex<Vec<Event>>>) {
        let size = TermSize::new(cols, rows);
        let mut config = TermConfig::default();
        config.osc52 = alacritty_terminal::term::Osc52::CopyPaste;
        let (listener, events_queue) = KojiEventListener::new();
        let term = Term::new(config, &size, listener);
        let parser = Processor::new();

        (Self {
            term, parser, rows, cols,
            color_overrides: HashMap::new(),
            prev_history_len: 0,
            zones: Vec::new(),
            cwd: None,
        }, events_queue)
    }
```

Add a method to process OSC events into zones (after `drain_scrollback`):

```rust
    /// Process OSC events from the byte scanner into zone state and CWD.
    pub fn apply_osc_events(&mut self, osc_events: &[crate::osc::OscEvent]) {
        use crate::osc::OscEventKind;
        let current_line = self.term.grid().cursor.point.line.0.max(0) as usize
            + self.term.grid().history_size();

        for event in osc_events {
            match &event.kind {
                OscEventKind::WorkingDirectory(path) => {
                    self.cwd = Some(path.clone());
                }
                OscEventKind::PromptStart => {
                    self.zones.push(CommandZone {
                        prompt_line: current_line,
                        input_line: None,
                        output_line: None,
                        end_line: None,
                        exit_code: None,
                        start_time: 0,
                        end_time: None,
                    });
                }
                OscEventKind::InputStart => {
                    if let Some(zone) = self.zones.last_mut() {
                        zone.input_line = Some(current_line);
                    }
                }
                OscEventKind::OutputStart => {
                    if let Some(zone) = self.zones.last_mut() {
                        zone.output_line = Some(current_line);
                        zone.start_time = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                    }
                }
                OscEventKind::CommandEnd { exit_code } => {
                    if let Some(zone) = self.zones.last_mut() {
                        zone.end_line = Some(current_line);
                        zone.exit_code = *exit_code;
                        zone.end_time = Some(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_millis() as u64)
                                .unwrap_or(0),
                        );
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Run `cargo check` to verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compilation errors in `lib.rs` because `TerminalEngine::new()` now returns a tuple. This is expected — we fix it in Task 3.

- [ ] **Step 3: Add zone tests**

Add to the bottom of `terminal.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::{OscEvent, OscEventKind};

    #[test]
    fn test_koji_event_listener_collects_events() {
        let (listener, queue) = KojiEventListener::new();
        listener.send_event(Event::Bell);
        listener.send_event(Event::Title("test".to_string()));
        let events = queue.lock();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn test_koji_event_listener_drain() {
        let (listener, queue) = KojiEventListener::new();
        listener.send_event(Event::Bell);
        {
            let mut events = queue.lock();
            assert_eq!(events.len(), 1);
            events.clear();
        }
        assert!(queue.lock().is_empty());
    }

    #[test]
    fn test_command_zone_lifecycle() {
        let (mut engine, _) = TerminalEngine::new(24, 80);
        let events = vec![
            OscEvent { kind: OscEventKind::PromptStart },
            OscEvent { kind: OscEventKind::InputStart },
            OscEvent { kind: OscEventKind::OutputStart },
            OscEvent { kind: OscEventKind::CommandEnd { exit_code: Some(0) } },
        ];
        engine.apply_osc_events(&events);
        assert_eq!(engine.zones.len(), 1);
        assert_eq!(engine.zones[0].exit_code, Some(0));
        assert!(engine.zones[0].end_line.is_some());
    }

    #[test]
    fn test_command_zone_missing_markers() {
        let (mut engine, _) = TerminalEngine::new(24, 80);
        // Only A and D, no B or C
        let events = vec![
            OscEvent { kind: OscEventKind::PromptStart },
            OscEvent { kind: OscEventKind::CommandEnd { exit_code: Some(1) } },
        ];
        engine.apply_osc_events(&events);
        assert_eq!(engine.zones.len(), 1);
        assert_eq!(engine.zones[0].input_line, None);
        assert_eq!(engine.zones[0].output_line, None);
        assert_eq!(engine.zones[0].exit_code, Some(1));
    }

    #[test]
    fn test_command_zone_overlapping() {
        let (mut engine, _) = TerminalEngine::new(24, 80);
        // Two A markers without D closing the first
        let events = vec![
            OscEvent { kind: OscEventKind::PromptStart },
            OscEvent { kind: OscEventKind::OutputStart },
            OscEvent { kind: OscEventKind::PromptStart }, // new zone before D
        ];
        engine.apply_osc_events(&events);
        assert_eq!(engine.zones.len(), 2);
    }

    #[test]
    fn test_cwd_tracking() {
        let (mut engine, _) = TerminalEngine::new(24, 80);
        let events = vec![
            OscEvent { kind: OscEventKind::WorkingDirectory("/tmp".to_string()) },
        ];
        engine.apply_osc_events(&events);
        assert_eq!(engine.cwd, Some("/tmp".to_string()));
    }
}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/terminal.rs
git commit -m "feat: KojiEventListener replaces VoidListener, add CommandZone tracking"
```

---

### Task 3: Wire EventListener + OSC Scanner into I/O Thread

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update Session struct and create_session command**

In `lib.rs`, update the Session struct to hold the events queue:

```rust
struct Session {
    pty: pty::PtyManager,
    engine: terminal::TerminalEngine,
    events: Arc<parking_lot::Mutex<Vec<alacritty_terminal::event::Event>>>,
}
```

Update the `create_session` function. Add a `cwd` parameter and update engine construction:

Change the signature to:
```rust
fn create_session(
    tab_id: String,
    rows: Option<u16>,
    cols: Option<u16>,
    cwd: Option<String>,
    sessions: State<'_, SessionMap>,
    app: tauri::AppHandle,
) -> Result<String, String> {
```

Change the PTY construction to pass CWD:
```rust
    let manager = pty::PtyManager::new(rows, cols, cwd.as_deref())
        .map_err(|e| format!("Failed to open PTY: {e}"))?;
```

Change the engine construction from:
```rust
    let engine = terminal::TerminalEngine::new(rows as usize, cols as usize);
```
to:
```rust
    let (engine, events_queue) = terminal::TerminalEngine::new(rows as usize, cols as usize);
```

Update the session insertion:
```rust
    {
        let mut map = sessions.0.lock();
        map.insert(tab_id.clone(), Session { pty: manager, engine, events: events_queue.clone() });
    }
```

- [ ] **Step 2: Update the I/O thread to scan OSC and drain events**

Replace the I/O thread body. Add new event name precomputations:
```rust
        let ev_cwd = format!("cwd-update-{}", thread_tab_id);
        let ev_title = format!("title-changed-{}", thread_tab_id);
        let ev_clipboard = format!("clipboard-store-{}", thread_tab_id);
        let ev_zones = format!("zones-update-{}", thread_tab_id);
```

Replace the inner loop body (after reading bytes) with:

```rust
            // Scan for OSC 7/133 before alacritty processes the bytes
            let osc_events = osc::scan_osc(&buf[..n]);

            // Lock SessionMap briefly to process bytes, apply OSC, and snapshot
            let (scrollback, snap, zones_changed, new_cwd) = {
                let mut map = sessions_arc.lock();
                match map.get_mut(&thread_tab_id) {
                    Some(session) => {
                        let prev_zone_count = session.engine.zones.len();
                        let prev_cwd = session.engine.cwd.clone();

                        session.engine.apply_osc_events(&osc_events);
                        session.engine.process_bytes(&buf[..n]);

                        let sb = session.engine.drain_scrollback();
                        let s = session.engine.snapshot();
                        let zones_changed = session.engine.zones.len() != prev_zone_count
                            || session.engine.zones.last()
                                .map(|z| z.end_line.is_some())
                                .unwrap_or(false);
                        let new_cwd = if session.engine.cwd != prev_cwd {
                            session.engine.cwd.clone()
                        } else {
                            None
                        };
                        (sb, Some(s), zones_changed, new_cwd)
                    }
                    None => break,
                }
            };

            // Drain alacritty events (Title, Clipboard, Bell, PtyWrite)
            {
                let mut events = events_arc.lock();
                for event in events.drain(..) {
                    match event {
                        alacritty_terminal::event::Event::Title(title) => {
                            let _ = app_handle.emit(&ev_title, &title);
                        }
                        alacritty_terminal::event::Event::ClipboardStore(_, text) => {
                            let _ = app_handle.emit(&ev_clipboard, &text);
                        }
                        alacritty_terminal::event::Event::Bell => {
                            let _ = app_handle.emit(&ev_bell, ());
                        }
                        alacritty_terminal::event::Event::PtyWrite(text) => {
                            let writer = reader_arc.lock().unwrap();
                            // PtyWrite needs the writer, but we only have the reader here.
                            // Write via the session's PTY instead.
                            drop(writer);
                            let map = sessions_arc.lock();
                            if let Some(session) = map.get(&thread_tab_id) {
                                let _ = session.pty.write(text.as_bytes());
                            }
                        }
                        _ => {} // Ignore other events
                    }
                }
            }

            // Emit events (no lock held)
            if !scrollback.is_empty() {
                let _ = app_handle.emit(&ev_scrollback, &scrollback);
            }
            if let Some(snap) = snap {
                let _ = app_handle.emit(&ev_output, &snap);
            }
            if let Some(cwd) = new_cwd {
                let _ = app_handle.emit(&ev_cwd, serde_json::json!({ "path": cwd }));
            }
            if zones_changed {
                let map = sessions_arc.lock();
                if let Some(session) = map.get(&thread_tab_id) {
                    let _ = app_handle.emit(&ev_zones, &session.engine.zones);
                }
            }
```

Remove the `has_bell` check_bell line and the old bell emit — bell is now handled via events.

Clone `events_queue` for the thread alongside `sessions_arc`:
```rust
    let events_arc = events_queue;
```

- [ ] **Step 3: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: Error in `PtyManager::new` — now expects 3 args. Fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: wire OSC scanner + event drain into I/O thread"
```

---

### Task 4: PTY Shell Integration Injection

**Files:**
- Modify: `src-tauri/src/pty.rs`
- Create: `resources/shell-integration/koji.zsh`
- Create: `resources/shell-integration/koji.bash`
- Create: `resources/shell-integration/koji.fish`
- Create: `resources/shell-integration/zdotdir/.zshenv`
- Create: `resources/shell-integration/bash-wrapper.sh`
- Create: `resources/shell-integration/fish-vendor/fish/vendor_conf.d/koji.fish`

- [ ] **Step 1: Update `PtyManager::new` to accept CWD and inject shell integration**

Replace the `PtyManager::new` signature and body:

```rust
    pub fn new(rows: u16, cols: u16, cwd: Option<&str>) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
```

After the `cmd.env("COLORTERM", "truecolor");` line and the env filtering loop, add shell integration injection:

```rust
        // Shell integration — auto-inject unless disabled
        let integration_dir = Self::shell_integration_dir();
        if let Some(ref dir) = integration_dir {
            cmd.env("KOJI_SHELL_INTEGRATION", "1");
            cmd.env("KOJI_SHELL_INTEGRATION_DIR", dir.to_string_lossy().as_ref());
            cmd.env("TERM_PROGRAM", "koji-baseline");
            cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));

            if shell.ends_with("zsh") {
                // ZDOTDIR trick: point to our wrapper that sources user config + koji.zsh
                let zdotdir = dir.join("zdotdir");
                if zdotdir.exists() {
                    let orig = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
                        dirs::home_dir().map(|h| h.to_string_lossy().to_string()).unwrap_or_default()
                    });
                    cmd.env("KOJI_ORIG_ZDOTDIR", &orig);
                    cmd.env("ZDOTDIR", zdotdir.to_string_lossy().as_ref());
                }
            } else if shell.ends_with("bash") {
                let wrapper = dir.join("bash-wrapper.sh");
                if wrapper.exists() {
                    cmd.arg("--rcfile");
                    cmd.arg(wrapper.to_string_lossy().as_ref());
                    // Remove -l flag for bash when using --rcfile (they conflict)
                    // Actually bash --rcfile replaces ~/.bashrc sourcing, which is what we want
                }
            } else if shell.ends_with("fish") {
                let fish_vendor = dir.join("fish-vendor");
                if fish_vendor.exists() {
                    let existing = std::env::var("XDG_DATA_DIRS").unwrap_or_default();
                    let new_dirs = if existing.is_empty() {
                        fish_vendor.to_string_lossy().to_string()
                    } else {
                        format!("{}:{}", fish_vendor.to_string_lossy(), existing)
                    };
                    cmd.env("XDG_DATA_DIRS", &new_dirs);
                }
            }
        }

        // Set CWD if provided (new tab inheriting from active tab)
        if let Some(dir) = cwd {
            let expanded = if dir.starts_with("~/") {
                dirs::home_dir().map(|h| h.join(&dir[2..])).unwrap_or_else(|| std::path::PathBuf::from(dir))
            } else {
                std::path::PathBuf::from(dir)
            };
            if expanded.is_dir() {
                cmd.cwd(&expanded);
            }
        }
```

Add the helper method to PtyManager:

```rust
    /// Locate the shell integration scripts directory.
    /// In dev: resources/shell-integration/ relative to the project root.
    /// In production: inside the app bundle Resources/ directory.
    fn shell_integration_dir() -> Option<std::path::PathBuf> {
        // Check config for disabled
        let config_path = dirs::home_dir()?.join(".koji-baseline").join("config.json");
        if config_path.exists() {
            if let Ok(data) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<serde_json::Value>(&data) {
                    if config.get("shell_integration").and_then(|v| v.as_str()) == Some("false") {
                        return None;
                    }
                }
            }
        }

        // Dev mode: check relative to executable
        let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("resources").join("shell-integration"));
        if let Some(ref p) = dev_path {
            if p.exists() { return dev_path; }
        }

        // Production: macOS app bundle
        if let Ok(exe) = std::env::current_exe() {
            let bundle_resources = exe
                .parent()  // MacOS/
                .and_then(|p| p.parent()) // Contents/
                .map(|p| p.join("Resources").join("shell-integration"));
            if let Some(ref p) = bundle_resources {
                if p.exists() { return bundle_resources; }
            }
        }

        None
    }
```

- [ ] **Step 2: Create shell integration scripts**

Create `resources/shell-integration/koji.zsh`:
```zsh
[[ -n "$KOJI_SHELL_INTEGRATION" ]] || return 0

# Restore original ZDOTDIR
[[ -n "$KOJI_ORIG_ZDOTDIR" ]] && ZDOTDIR="$KOJI_ORIG_ZDOTDIR"
unset KOJI_ORIG_ZDOTDIR

_koji_precmd() {
    local ec=$?
    [[ -n "$_koji_cmd_started" ]] && printf '\e]133;D;%d\a' "$ec"
    _koji_cmd_started=
    printf '\e]7;file://%s%s\a' "${HOST:-$(hostname)}" "$PWD"
    printf '\e]133;A\a'
}

_koji_preexec() {
    _koji_cmd_started=1
    printf '\e]133;C\a'
}

_koji_zle_line_init() { printf '\e]133;B\a'; }

autoload -Uz add-zsh-hook
add-zsh-hook precmd _koji_precmd
add-zsh-hook preexec _koji_preexec
zle -N zle-line-init _koji_zle_line_init
```

Create `resources/shell-integration/zdotdir/.zshenv`:
```zsh
# Koji Baseline ZDOTDIR wrapper — sources user's real .zshenv then koji integration
_koji_real_zdotdir="${KOJI_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$_koji_real_zdotdir/.zshenv" ]] && source "$_koji_real_zdotdir/.zshenv"
source "${KOJI_SHELL_INTEGRATION_DIR}/koji.zsh"
unset _koji_real_zdotdir
```

Create `resources/shell-integration/koji.bash`:
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
PS1="${PS1}\[\e]133;B\a\]"
```

Create `resources/shell-integration/bash-wrapper.sh`:
```bash
# Koji Baseline bash wrapper — sources user's .bashrc then koji integration
[[ -f ~/.bashrc ]] && source ~/.bashrc
source "${KOJI_SHELL_INTEGRATION_DIR}/koji.bash"
```

Create `resources/shell-integration/koji.fish`:
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

Create `resources/shell-integration/fish-vendor/fish/vendor_conf.d/koji.fish` as a symlink or copy:
```fish
# Koji Baseline fish vendor config — loads shell integration
test -n "$KOJI_SHELL_INTEGRATION"; or exit 0
source "$KOJI_SHELL_INTEGRATION_DIR/koji.fish"
```

- [ ] **Step 3: Run `cargo check`**

Run: `cd src-tauri && cargo check`
Expected: PASS (all Rust compiles)

- [ ] **Step 4: Run all Rust tests**

Run: `cd src-tauri && cargo test -- --nocapture`
Expected: All osc and terminal tests pass

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty.rs resources/
git commit -m "feat: shell integration auto-injection (zsh/bash/fish) with CWD passing"
```

---

### Task 5: Frontend — CWD, Title, Clipboard, Zone Event Listeners

**Files:**
- Modify: `src/tabs/tab-session.ts`
- Modify: `src/tabs/tab-manager.ts`

- [ ] **Step 1: Add CWD, title, clipboard, and zone listeners to TabSession**

In `tab-session.ts`, add new private fields after `private _started = false;`:

```typescript
  private _cwd = "";
  private _zones: CommandZone[] = [];
  private _onCwdChanged?: (path: string) => void;
```

Add a public getter and callback setter:

```typescript
  get cwd(): string { return this._cwd; }
  get zones(): CommandZone[] { return this._zones; }

  onCwdChanged(cb: (path: string) => void): void {
    this._onCwdChanged = cb;
  }
```

Add the `CommandZone` interface at the top of the file (after imports):

```typescript
export interface CommandZone {
  prompt_line: number;
  input_line: number | null;
  output_line: number | null;
  end_line: number | null;
  exit_code: number | null;
  start_time: number;
  end_time: number | null;
}
```

In the `start()` method, after the bell listener, add:

```typescript
    // CWD from OSC 7
    const cwdUn = await listen<{ path: string }>(`cwd-update-${this.id}`, (event) => {
      this._cwd = event.payload.path;
      this._onCwdChanged?.(event.payload.path);
    });
    this.unlisteners.push(cwdUn);

    // Title from OSC 0/1/2
    const titleUn = await listen<string>(`title-changed-${this.id}`, (event) => {
      if (this._active) document.title = event.payload;
    });
    this.unlisteners.push(titleUn);

    // Clipboard store from OSC 52
    const clipUn = await listen<string>(`clipboard-store-${this.id}`, (event) => {
      navigator.clipboard.writeText(event.payload).catch(console.warn);
    });
    this.unlisteners.push(clipUn);

    // Zones from OSC 133
    const zonesUn = await listen<CommandZone[]>(`zones-update-${this.id}`, (event) => {
      this._zones = event.payload;
    });
    this.unlisteners.push(zonesUn);
```

- [ ] **Step 2: Update TabManager to pass CWD and wire tab naming**

In `tab-manager.ts`, update `createTab()`. Before `await session.start()`, wire CWD callback and pass CWD to start:

Change `await session.start();` to `await session.start(currentCwd);` where `currentCwd` is captured before deactivating the old tab:

```typescript
    const currentCwd = current?.cwd || "";
```

And wire CWD → tab name:

```typescript
    session.onCwdChanged((path) => {
      const basename = path.split("/").pop() || path;
      session.name = basename;
      this.renderTabBar();
    });
```

In `tab-session.ts`, update `start()` to accept optional CWD:

```typescript
  async start(cwd?: string): Promise<void> {
```

And pass it to create_session:

```typescript
    await invoke("create_session", { tabId: this.id, rows, cols, cwd: cwd || null });
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tabs/tab-session.ts src/tabs/tab-manager.ts
git commit -m "feat: frontend listens for CWD, title, clipboard, zone events"
```

---

### Task 6: Zone Navigation (Cmd+Up / Cmd+Down)

**Files:**
- Create: `src/terminal/zones.ts`
- Modify: `src/tabs/tab-session.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create `zones.ts`**

```typescript
// zones.ts — Cmd+Up/Down navigation between command zones (OSC 133 prompts)

import type { DOMGrid } from "./dom-grid";
import type { CommandZone } from "../tabs/tab-session";

/**
 * Find the prompt line of the nearest zone in the given direction.
 * Returns the prompt_line to scroll to, or null if no zone found.
 */
export function findNearestZone(
  zones: CommandZone[],
  direction: "up" | "down",
  currentScrollTop: number,
  lineHeight: number,
): number | null {
  if (zones.length === 0) return null;

  const currentLine = Math.floor(currentScrollTop / lineHeight);

  if (direction === "up") {
    // Find the last zone whose prompt_line is above the current view
    for (let i = zones.length - 1; i >= 0; i--) {
      if (zones[i].prompt_line < currentLine) {
        return zones[i].prompt_line;
      }
    }
    return null;
  } else {
    // Find the first zone whose prompt_line is below the current view
    for (let i = 0; i < zones.length; i++) {
      if (zones[i].prompt_line > currentLine) {
        return zones[i].prompt_line;
      }
    }
    return null;
  }
}

/**
 * Scroll the grid to a specific line (zone navigation).
 */
export function scrollToLine(
  grid: DOMGrid,
  line: number,
  lineHeight: number,
): void {
  const scrollEl = grid.getScrollElement();
  const targetTop = line * lineHeight;
  scrollEl.scrollTo({ top: targetTop, behavior: "smooth" });
}
```

- [ ] **Step 2: Add jump methods to TabSession**

In `tab-session.ts`, add:

```typescript
  jumpToPreviousZone(): void {
    const lineHeight = this.grid.getFontSize() * 1.3;
    const scrollTop = this.grid.getScrollElement().scrollTop;
    const target = findNearestZone(this._zones, "up", scrollTop, lineHeight);
    if (target !== null) scrollToLine(this.grid, target, lineHeight);
  }

  jumpToNextZone(): void {
    const lineHeight = this.grid.getFontSize() * 1.3;
    const scrollTop = this.grid.getScrollElement().scrollTop;
    const target = findNearestZone(this._zones, "down", scrollTop, lineHeight);
    if (target !== null) scrollToLine(this.grid, target, lineHeight);
  }
```

Add the import at the top:
```typescript
import { findNearestZone, scrollToLine } from "../terminal/zones";
```

- [ ] **Step 3: Wire Cmd+Up/Down in main.ts**

In `main.ts`, after the Cmd+K handler (around line 230), add:

```typescript
  // ── Cmd+Up/Down — jump between command zones ────────────────────────────
  if (metaKey && key === "ArrowUp" && !event.shiftKey) {
    event.preventDefault();
    tab.jumpToPreviousZone();
    return;
  }
  if (metaKey && key === "ArrowDown" && !event.shiftKey) {
    event.preventDefault();
    tab.jumpToNextZone();
    return;
  }
```

- [ ] **Step 4: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/terminal/zones.ts src/tabs/tab-session.ts src/main.ts
git commit -m "feat: Cmd+Up/Down zone navigation between command prompts"
```

---

### Task 7: /shell-integration Slash Command

**Files:**
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts` (if command dispatch needs updating)

- [ ] **Step 1: Add /shell-integration handler**

In `handlers.ts`, add:

```typescript
export async function handleShellIntegration(args: string): Promise<DispatchResult> {
  const arg = args.trim().toLowerCase();

  if (arg === "on") {
    await invoke("save_config", { key: "shell_integration", value: "true" });
    return { output: "Shell integration enabled. New tabs will inject OSC 7/133 hooks.", isError: false };
  }

  if (arg === "off") {
    await invoke("save_config", { key: "shell_integration", value: "false" });
    return { output: "Shell integration disabled. New tabs will not inject hooks.", isError: false };
  }

  const current = await invoke<string>("load_config", { key: "shell_integration" }).catch(() => "");
  const status = current === "false" ? "off" : "on (default)";
  return { output: `Shell integration: ${status}\nUsage: /shell-integration [on|off]`, isError: false };
}
```

- [ ] **Step 2: Wire it into the command router**

In `router.ts`, add the case for `/shell-integration`. Find where other commands are dispatched and add:

```typescript
if (cmd === "/shell-integration" || cmd.startsWith("/shell-integration ")) {
  const args = line.slice("/shell-integration".length);
  return handleShellIntegration(args);
}
```

Add to the help menu in `handlers.ts` (in the items array):

```typescript
    { label: "/shell-integration", value: "shell-integration", description: "Toggle shell integration (OSC 7/133)" },
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/commands/handlers.ts src/commands/router.ts
git commit -m "feat: /shell-integration slash command (on/off toggle)"
```

---

### Task 8: Synchronized Rendering + ClipboardLoad

**Files:**
- Modify: `src-tauri/src/osc.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add DCS sync detection to the OSC scanner**

In `osc.rs`, add two new variants to `OscEventKind`:

```rust
    SyncStart,
    SyncEnd,
```

In `scan_osc`, add detection for DCS mode 2026 sequences before the OSC check:

```rust
        // DCS mode 2026 synchronized update: CSI ? 2026 h (start) / l (end)
        // Format: ESC [ ? 2026 h  or  ESC [ ? 2026 l
        if bytes[i] == 0x1b && i + 5 < len
            && bytes[i + 1] == b'['
            && bytes[i + 2] == b'?'
            && bytes[i + 3] == b'2'
            && bytes[i + 4] == b'0'
            && i + 7 <= len
            && bytes[i + 5] == b'2'
            && bytes[i + 6] == b'6'
        {
            if i + 8 <= len && bytes[i + 7] == b'h' {
                events.push(OscEvent { kind: OscEventKind::SyncStart });
                i += 8;
                continue;
            }
            if i + 8 <= len && bytes[i + 7] == b'l' {
                events.push(OscEvent { kind: OscEventKind::SyncEnd });
                i += 8;
                continue;
            }
        }
```

Add tests:

```rust
    #[test]
    fn test_scan_sync_start_end() {
        let bytes = b"\x1b[?2026h some content \x1b[?2026l";
        let events = scan_osc(bytes);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, OscEventKind::SyncStart);
        assert_eq!(events[1].kind, OscEventKind::SyncEnd);
    }
```

- [ ] **Step 2: Add sync state tracking and ClipboardLoad to the I/O thread**

In `lib.rs`, add a `sync_active` bool and `sync_started` Instant before the I/O loop:

```rust
        let mut sync_active = false;
        let mut sync_started = std::time::Instant::now();
        const SYNC_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(100);
```

In the I/O loop, after scanning OSC events, check for sync markers:

```rust
            for osc_ev in &osc_events {
                match osc_ev.kind {
                    osc::OscEventKind::SyncStart => {
                        sync_active = true;
                        sync_started = std::time::Instant::now();
                    }
                    osc::OscEventKind::SyncEnd => {
                        sync_active = false;
                    }
                    _ => {}
                }
            }

            // Timeout safety: force-emit if sync has been pending > 100ms
            if sync_active && sync_started.elapsed() > SYNC_TIMEOUT {
                sync_active = false;
            }
```

Wrap the snapshot emit in a sync guard:

```rust
            if let Some(snap) = snap {
                if !sync_active {
                    let _ = app_handle.emit(&ev_output, &snap);
                }
            }
```

Add `ClipboardLoad` handling in the event drain. After the `ClipboardStore` case:

```rust
                        alacritty_terminal::event::Event::ClipboardLoad(_, formatter) => {
                            // Read clipboard content and send formatted response back to PTY
                            // We can't read clipboard from the Rust thread, so emit to frontend
                            // The frontend reads clipboard and writes the response via write_to_session
                            let ev_clip_load = format!("clipboard-load-{}", thread_tab_id);
                            let _ = app_handle.emit(&ev_clip_load, ());
                        }
```

- [ ] **Step 3: Add ClipboardLoad listener in tab-session.ts**

In `tab-session.ts`, add after the clipboard-store listener:

```typescript
    // Clipboard load from OSC 52 (remote app requesting clipboard content)
    const clipLoadUn = await listen(`clipboard-load-${this.id}`, async () => {
      try {
        const text = await navigator.clipboard.readText();
        // Send clipboard content back to PTY as OSC 52 response
        const encoded = btoa(text);
        const response = `\x1b]52;c;${encoded}\x07`;
        const bytes = Array.from(new TextEncoder().encode(response));
        await this.writePty(bytes);
      } catch {
        // Clipboard read denied — silently ignore
      }
    });
    this.unlisteners.push(clipLoadUn);
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test -- --nocapture`
Expected: All tests pass including new sync test

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/osc.rs src-tauri/src/lib.rs src/tabs/tab-session.ts
git commit -m "feat: synchronized rendering (DCS 2026) + OSC 52 clipboard load"
```

---

### Task 9: Failed Zone Visual Indicator + CWD Priority

**Files:**
- Modify: `src/styles/wallace.css`
- Modify: `src/tabs/tab-session.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add CSS for failed zone indicator**

In `wallace.css`, add after the `.tab-exit-message` block:

```css
/* ── Zone indicators ─────────────────────────────────────────────────────── */

.zone-failed-marker {
  position: absolute;
  left: 0;
  width: 3px;
  background: var(--koji-error);
  border-radius: 1px;
  pointer-events: none;
  z-index: 4;
}
```

- [ ] **Step 2: Render failed zone markers in TabSession**

In `tab-session.ts`, add a method to render zone indicators:

```typescript
  private renderZoneIndicators(): void {
    // Remove existing markers
    this.containerEl.querySelectorAll(".zone-failed-marker").forEach((el) => el.remove());

    const lineHeight = this.grid.getFontSize() * 1.3;
    const scrollEl = this.grid.getScrollElement();
    const scrollbackLines = scrollEl.querySelectorAll(".grid-row").length - 0; // approximate

    for (const zone of this._zones) {
      if (zone.exit_code !== null && zone.exit_code !== 0 && zone.prompt_line !== undefined) {
        const marker = document.createElement("div");
        marker.className = "zone-failed-marker";
        const top = zone.prompt_line * lineHeight;
        const height = ((zone.end_line ?? zone.prompt_line) - zone.prompt_line + 1) * lineHeight;
        marker.style.top = `${top}px`;
        marker.style.height = `${Math.max(lineHeight, height)}px`;
        scrollEl.appendChild(marker);
      }
    }
  }
```

Call it when zones update (in the zones listener):

```typescript
    const zonesUn = await listen<CommandZone[]>(`zones-update-${this.id}`, (event) => {
      this._zones = event.payload;
      this.renderZoneIndicators();
    });
```

- [ ] **Step 3: CWD priority — OSC 7 overrides monitor.rs polling**

In `main.ts`, update the existing `cwd-changed` listener (around line 139) to only update if OSC 7 hasn't set a CWD recently:

```typescript
// ─── CWD tracking — OSC 7 takes priority over monitor.rs polling ────────────
let oscCwdActive = false;

// Listen for OSC 7 CWD from any tab (via tab-session onCwdChanged)
// This is already handled per-tab, but for the dashboard bottom bar:
```

In `tab-manager.ts`, when wiring `onCwdChanged`, also update the dashboard:

After the existing `session.onCwdChanged` callback, add dashboard update:

```typescript
    session.onCwdChanged((path) => {
      const basename = path.split("/").pop() || path;
      session.name = basename;
      this.renderTabBar();
      // Update dashboard bottom bar
      const cwdEl = document.getElementById("cwd-path");
      if (cwdEl && session.active) cwdEl.textContent = path.replace(/^\/Users\/[^/]+/, "~");
    });
```

The existing `cwd-changed` listener from `monitor.rs` stays as-is — it provides CWD when shell integration is disabled. OSC 7 events arrive more frequently and will naturally override the displayed value.

- [ ] **Step 4: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/styles/wallace.css src/tabs/tab-session.ts src/tabs/tab-manager.ts src/main.ts
git commit -m "feat: failed zone red markers + OSC 7 CWD dashboard updates"
```

---

### Task 10: Full Build + Verification

**Files:** None new — verification only.

- [ ] **Step 1: Run full TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full Rust test suite**

Run: `cd src-tauri && cargo test -- --nocapture`
Expected: All tests pass (osc + terminal)

- [ ] **Step 3: Build frontend**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 4: Build Rust release**

Run: `cd src-tauri && cargo build --release`
Expected: Clean compilation

- [ ] **Step 5: Commit final build state**

Only if there were any fixups needed from the build:
```bash
git add -A && git commit -m "fix: build fixups for Phase 1 shell integration"
```

---

### Task Summary

| Task | Component | Dependencies |
|------|-----------|--------------|
| 1 | OSC byte scanner (osc.rs) | None |
| 2 | KojiEventListener + zones (terminal.rs) | Task 1 |
| 3 | I/O thread wiring (lib.rs) | Tasks 1, 2 |
| 4 | PTY injection + shell scripts | Task 3 |
| 5 | Frontend event listeners | Task 3 |
| 6 | Zone navigation (Cmd+Up/Down) | Task 5 |
| 7 | /shell-integration command | Task 5 |
| 8 | Synchronized rendering + ClipboardLoad | Tasks 1, 3 |
| 9 | Failed zone indicator + CWD priority | Tasks 5, 6 |
| 10 | Full build verification | All |
