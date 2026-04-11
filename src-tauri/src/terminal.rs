// terminal.rs — Terminal Engine: VTE parser + grid snapshot → JSON-serializable state
// alacritty_terminal wraps the hard bits; we dress the output in whatever theme is active.

use alacritty_terminal::Term;
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::Config as TermConfig;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use alacritty_terminal::term::cell::Flags;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex as PlMutex;

// ─── Serializable output types ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct RenderCell {
    pub character: String,
    pub fg: [u8; 3],
    pub bg: [u8; 3],
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub dim: bool,
    pub strikethrough: bool,
    pub hidden: bool,
    pub blink: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CursorPos {
    pub row: usize,
    pub col: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct GridSnapshot {
    pub cells: Vec<Vec<RenderCell>>,
    pub cursor: CursorPos,
    pub rows: usize,
    pub cols: usize,
    pub is_alt_screen: bool,
    pub mouse_mode: u8,
    pub title: String,
}

// ─── Named colour palette ──────────────────────────────────────────────────
// Default: Wallace amber. Overridden at runtime by set_theme_colors().

fn named_to_rgb_default(name: NamedColor) -> [u8; 3] {
    match name {
        NamedColor::Black | NamedColor::DimBlack => [10, 10, 10],
        NamedColor::Red | NamedColor::BrightRed | NamedColor::DimRed => [255, 69, 0],
        NamedColor::Green | NamedColor::BrightGreen | NamedColor::DimGreen => [58, 106, 58],
        NamedColor::Yellow
        | NamedColor::BrightYellow
        | NamedColor::DimYellow
        | NamedColor::BrightBlack => [74, 58, 26],
        NamedColor::Blue
        | NamedColor::BrightBlue
        | NamedColor::DimBlue
        | NamedColor::White
        | NamedColor::BrightWhite
        | NamedColor::DimWhite => [204, 122, 0],
        NamedColor::Magenta
        | NamedColor::BrightMagenta
        | NamedColor::DimMagenta => [255, 106, 0],
        NamedColor::Cyan | NamedColor::BrightCyan | NamedColor::DimCyan => [153, 107, 0],
        NamedColor::Foreground
        | NamedColor::BrightForeground
        | NamedColor::DimForeground => [204, 122, 0],
        NamedColor::Background => [10, 10, 10],
        NamedColor::Cursor => [255, 140, 0],
    }
}

/// Map any NamedColor variant to its canonical override key string.
/// Bright/Dim variants all collapse to the same base key so theme overrides
/// apply uniformly regardless of how the terminal emits the colour.
fn named_color_key(name: NamedColor) -> &'static str {
    match name {
        NamedColor::Black | NamedColor::DimBlack => "black",
        NamedColor::Red | NamedColor::BrightRed | NamedColor::DimRed => "red",
        NamedColor::Green | NamedColor::BrightGreen | NamedColor::DimGreen => "green",
        NamedColor::Yellow
        | NamedColor::BrightYellow
        | NamedColor::DimYellow
        | NamedColor::BrightBlack => "yellow",
        NamedColor::Blue | NamedColor::BrightBlue | NamedColor::DimBlue => "blue",
        NamedColor::Magenta | NamedColor::BrightMagenta | NamedColor::DimMagenta => "magenta",
        NamedColor::Cyan | NamedColor::BrightCyan | NamedColor::DimCyan => "cyan",
        NamedColor::White | NamedColor::BrightWhite | NamedColor::DimWhite => "white",
        NamedColor::Foreground | NamedColor::BrightForeground | NamedColor::DimForeground => {
            "foreground"
        }
        NamedColor::Background => "background",
        NamedColor::Cursor => "cursor",
    }
}

/// Resolve a NamedColor against a theme override map, falling back to Wallace defaults.
fn named_to_rgb(name: NamedColor, overrides: &HashMap<String, [u8; 3]>) -> [u8; 3] {
    let key = named_color_key(name);
    overrides.get(key).copied().unwrap_or_else(|| named_to_rgb_default(name))
}

/// Map a u8 index from the xterm-256 palette to an RGB triple.
/// Indices 0–15 hit the named table, 16–231 are the 6×6×6 colour cube,
/// 232–255 are the 24-step greyscale ramp.
fn indexed_to_rgb(idx: u8) -> [u8; 3] {
    match idx {
        // Named colours — defer to Wallace amber palette
        0 => [10, 10, 10],
        1 => [255, 69, 0],
        2 => [58, 106, 58],
        3 => [255, 140, 0],
        4 => [204, 122, 0],
        5 => [255, 106, 0],
        6 => [153, 107, 0],
        7 => [204, 122, 0],
        8 => [74, 58, 26],
        9 => [255, 69, 0],
        10 => [58, 106, 58],
        11 => [255, 140, 0],
        12 => [204, 122, 0],
        13 => [255, 106, 0],
        14 => [153, 107, 0],
        15 => [204, 122, 0],
        // 6×6×6 colour cube: index = 16 + 36r + 6g + b, each component 0..5 → 0,95,135,175,215,255
        16..=231 => {
            let i = idx - 16;
            let b = i % 6;
            let g = (i / 6) % 6;
            let r = i / 36;
            let to_byte = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
            [to_byte(r), to_byte(g), to_byte(b)]
        }
        // 24-step greyscale ramp: 8, 18, 28 … 238
        232..=255 => {
            let v = 8 + (idx - 232) * 10;
            [v, v, v]
        }
    }
}

/// Resolve any alacritty Color variant to a concrete RGB triple.
pub fn color_to_rgb(color: Color, overrides: &HashMap<String, [u8; 3]>) -> [u8; 3] {
    match color {
        Color::Named(name) => named_to_rgb(name, overrides),
        Color::Spec(Rgb { r, g, b }) => [r, g, b],
        Color::Indexed(idx) => indexed_to_rgb(idx),
    }
}

// ─── cell_to_render ───────────────────────────────────────────────────────────

pub fn cell_to_render(
    cell: &alacritty_terminal::term::cell::Cell,
    overrides: &HashMap<String, [u8; 3]>,
) -> RenderCell {
    let bold = cell.flags.contains(Flags::BOLD);
    let italic = cell.flags.contains(Flags::ITALIC);
    let underline = cell.flags.contains(Flags::UNDERLINE);
    let dim = cell.flags.contains(Flags::DIM);
    let strikethrough = cell.flags.contains(Flags::STRIKEOUT);
    let hidden = cell.flags.contains(Flags::HIDDEN);
    // alacritty_terminal 0.25.1 has no BLINK flag — keep field for frontend compat
    let blink = false;

    // Respect INVERSE flag — swap fg/bg
    let (fg_color, bg_color) = if cell.flags.contains(Flags::INVERSE) {
        (cell.bg, cell.fg)
    } else {
        (cell.fg, cell.bg)
    };

    RenderCell {
        character: cell.c.to_string(),
        fg: color_to_rgb(fg_color, overrides),
        bg: color_to_rgb(bg_color, overrides),
        bold,
        italic,
        underline,
        dim,
        strikethrough,
        hidden,
        blink,
    }
}

// ─── KojiEventListener ───────────────────────────────────────────────────────
// Replaces VoidListener — captures Title, Bell, Clipboard, etc. for the I/O thread.

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

// ─── CommandZone ─────────────────────────────────────────────────────────────
// Tracks a single prompt→command→output→completion lifecycle.

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

// ─── TerminalEngine ───────────────────────────────────────────────────────────

/// Owns the Term + VTE Processor. Feed it raw PTY bytes; snapshot the grid whenever.
pub struct TerminalEngine {
    term: Term<KojiEventListener>,
    parser: Processor,
    rows: usize,
    cols: usize,
    /// Runtime theme overrides — maps colour key (e.g. "red") → RGB triple.
    /// Empty = use Wallace defaults. Populated by set_theme_colors().
    pub color_overrides: HashMap<String, [u8; 3]>,
    /// Tracks how many history lines existed at the last drain_scrollback() call.
    prev_history_len: usize,
    /// Command zone tracking — each prompt→output cycle is one zone.
    pub zones: Vec<CommandZone>,
    /// Current working directory as reported by OSC 7 / shell integration.
    pub cwd: Option<String>,
}

impl TerminalEngine {
    pub fn new(rows: usize, cols: usize) -> (Self, Arc<PlMutex<Vec<Event>>>) {
        let size = TermSize::new(cols, rows);
        let mut config = TermConfig::default();
        config.osc52 = alacritty_terminal::term::Osc52::CopyPaste;
        let (listener, event_buf) = KojiEventListener::new();
        let term = Term::new(config, &size, listener);
        let parser = Processor::new();

        let engine = Self {
            term,
            parser,
            rows,
            cols,
            color_overrides: HashMap::new(),
            prev_history_len: 0,
            zones: Vec::new(),
            cwd: None,
        };
        (engine, event_buf)
    }

    /// Process parsed OSC events into zone state and CWD tracking.
    /// `cursor_line` is the current terminal cursor row (used as the line marker).
    /// `now_ms` is the current epoch milliseconds (used for start/end timestamps).
    ///
    /// Zone lifecycle: A→push new zone, B→set input_line, C→set output_line+start_time,
    /// D→set end_line+exit_code+end_time.
    pub fn apply_osc_events(
        &mut self,
        events: &[crate::osc::OscEvent],
        cursor_line: usize,
        now_ms: u64,
    ) {
        use crate::osc::OscEventKind;
        for ev in events {
            match &ev.kind {
                OscEventKind::PromptStart => {
                    self.zones.push(CommandZone {
                        prompt_line: cursor_line,
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
                        zone.input_line = Some(cursor_line);
                    }
                }
                OscEventKind::OutputStart => {
                    if let Some(zone) = self.zones.last_mut() {
                        zone.output_line = Some(cursor_line);
                        zone.start_time = now_ms;
                    }
                }
                OscEventKind::CommandEnd { exit_code } => {
                    if let Some(zone) = self.zones.last_mut() {
                        zone.end_line = Some(cursor_line);
                        zone.exit_code = *exit_code;
                        zone.end_time = Some(now_ms);
                    }
                }
                OscEventKind::WorkingDirectory(path) => {
                    self.cwd = Some(path.clone());
                }
            }
        }
    }

    /// Apply a theme colour map from a JSON value (object of key → [r, g, b]).
    /// Keys match TerminalColors: black, red, green, yellow, blue, magenta, cyan,
    /// white, foreground, background, cursor.
    pub fn set_theme_colors(&mut self, colors: &serde_json::Value) {
        self.color_overrides.clear();
        if let Some(map) = colors.as_object() {
            for (key, val) in map {
                if let Some(arr) = val.as_array() {
                    if arr.len() == 3 {
                        let r = arr[0].as_u64().unwrap_or(0) as u8;
                        let g = arr[1].as_u64().unwrap_or(0) as u8;
                        let b = arr[2].as_u64().unwrap_or(0) as u8;
                        self.color_overrides.insert(key.clone(), [r, g, b]);
                    }
                }
            }
        }
    }

    /// Check if raw bytes contain a BEL character.
    pub fn check_bell(bytes: &[u8]) -> bool {
        bytes.contains(&0x07)
    }

    /// Push raw PTY bytes through the VTE parser into the terminal state machine.
    pub fn process_bytes(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    /// Snapshot the current visible grid into a serializable struct for the frontend.
    pub fn snapshot(&self) -> GridSnapshot {
        let grid = self.term.grid();
        let cursor_point = grid.cursor.point;

        let mut cells: Vec<Vec<RenderCell>> = Vec::with_capacity(self.rows);

        for line_idx in 0..self.rows {
            // alacritty grid: line 0 is the topmost visible line.
            // Grid index uses signed Line type; viewport top = Line(0).
            let line = Line(line_idx as i32);
            let mut row: Vec<RenderCell> = Vec::with_capacity(self.cols);

            for col_idx in 0..self.cols {
                let col = Column(col_idx);
                let cell = &grid[line][col];
                row.push(cell_to_render(cell, &self.color_overrides));
            }

            cells.push(row);
        }

        // cursor.point.line is relative to the terminal origin (negative = in scrollback).
        // For the viewport snapshot we map it to a visible row index.
        let cursor_row = cursor_point.line.0.max(0) as usize;
        let cursor_col = cursor_point.column.0;

        let mode = self.term.mode();
        let mouse_mode = {
            let mut m: u8 = 0;
            if mode.contains(TermMode::MOUSE_REPORT_CLICK) { m |= 1; }
            if mode.contains(TermMode::MOUSE_DRAG) { m |= 2; }
            if mode.contains(TermMode::MOUSE_MOTION) { m |= 4; }
            if mode.contains(TermMode::SGR_MOUSE) { m |= 8; }
            m
        };

        // alacritty_terminal 0.25.1 stores title privately with no public accessor,
        // so we default to empty. OSC 0/1/2 title support requires a custom EventListener.
        let title = String::new();

        GridSnapshot {
            cells,
            cursor: CursorPos { row: cursor_row, col: cursor_col },
            rows: self.rows,
            cols: self.cols,
            is_alt_screen: mode.contains(TermMode::ALT_SCREEN),
            mouse_mode,
            title,
        }
    }

    /// Expose the underlying grid for cursor position queries.
    pub fn term_grid(&self) -> &alacritty_terminal::grid::Grid<alacritty_terminal::term::cell::Cell> {
        self.term.grid()
    }

    /// Resize the terminal. Kicks alacritty's reflow logic.
    pub fn resize(&mut self, rows: usize, cols: usize) {
        self.rows = rows;
        self.cols = cols;
        let size = TermSize::new(cols, rows);
        self.term.resize(size);
    }

    /// Return any new scrollback lines since the last call.
    /// Lines that scrolled off the top of the viewport into history are captured
    /// and returned as Vec<Vec<RenderCell>> so the frontend can prepend them.
    pub fn drain_scrollback(&mut self) -> Vec<Vec<RenderCell>> {
        let grid = self.term.grid();
        let history_len = grid.history_size();

        if history_len <= self.prev_history_len {
            self.prev_history_len = history_len;
            return Vec::new();
        }

        let new_count = history_len - self.prev_history_len;
        let mut result = Vec::with_capacity(new_count);

        // History lines are accessed via negative Line indices.
        // Line(-(history_len as i32)) is the oldest line in history.
        // The newly added lines are the ones closest to the viewport top,
        // i.e. at indices -(new_count) .. -1 relative to viewport.
        // But we want them in chronological order (oldest new line first),
        // which is -(new_count) up to -1.
        for i in (1..=new_count).rev() {
            let line = Line(-(i as i32));
            let row_data = &grid[line];
            let mut cells = Vec::with_capacity(self.cols);
            for col_idx in 0..self.cols {
                let col = Column(col_idx);
                let cell = &row_data[col];
                cells.push(cell_to_render(cell, &self.color_overrides));
            }
            result.push(cells);
        }

        self.prev_history_len = history_len;
        result
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use alacritty_terminal::event::Event;

    #[test]
    fn test_koji_event_listener_collects_events() {
        let (listener, buf) = KojiEventListener::new();
        listener.send_event(Event::Bell);
        listener.send_event(Event::Title("hello".into()));
        let events = buf.lock();
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], Event::Bell));
        assert!(matches!(&events[1], Event::Title(t) if t == "hello"));
    }

    #[test]
    fn test_koji_event_listener_drain() {
        let (listener, buf) = KojiEventListener::new();
        listener.send_event(Event::Bell);
        listener.send_event(Event::Wakeup);
        {
            let mut events = buf.lock();
            assert_eq!(events.len(), 2);
            events.clear();
        }
        let events = buf.lock();
        assert!(events.is_empty());
    }

    #[test]
    fn test_command_zone_lifecycle() {
        use crate::osc::{OscEvent, OscEventKind};
        let (mut engine, _buf) = TerminalEngine::new(24, 80);
        // A→B→C→D full lifecycle via apply_osc_events
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::PromptStart }],
            0, 0,
        );
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::InputStart }],
            1, 0,
        );
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::OutputStart }],
            2, 1000,
        );
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::CommandEnd { exit_code: Some(0) } }],
            5, 2000,
        );

        assert_eq!(engine.zones.len(), 1);
        let zone = &engine.zones[0];
        assert_eq!(zone.prompt_line, 0);
        assert_eq!(zone.input_line, Some(1));
        assert_eq!(zone.output_line, Some(2));
        assert_eq!(zone.end_line, Some(5));
        assert_eq!(zone.exit_code, Some(0));
        assert_eq!(zone.start_time, 1000);
        assert_eq!(zone.end_time, Some(2000));
    }

    #[test]
    fn test_command_zone_missing_markers() {
        use crate::osc::{OscEvent, OscEventKind};
        let (mut engine, _buf) = TerminalEngine::new(24, 80);
        // A→D only — input/output lines stay None
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::PromptStart }],
            3, 0,
        );
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::CommandEnd { exit_code: Some(127) } }],
            4, 500,
        );

        let zone = &engine.zones[0];
        assert_eq!(zone.prompt_line, 3);
        assert!(zone.input_line.is_none());
        assert!(zone.output_line.is_none());
        assert_eq!(zone.end_line, Some(4));
        assert_eq!(zone.exit_code, Some(127));
    }

    #[test]
    fn test_command_zone_overlapping() {
        use crate::osc::{OscEvent, OscEventKind};
        let (mut engine, _buf) = TerminalEngine::new(24, 80);
        // A→C→A creates 2 zones (second prompt starts before first finishes)
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::PromptStart }],
            0, 0,
        );
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::OutputStart }],
            2, 100,
        );
        // Second prompt — new zone before first finished
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::PromptStart }],
            5, 200,
        );

        assert_eq!(engine.zones.len(), 2);
        assert_eq!(engine.zones[0].prompt_line, 0);
        assert_eq!(engine.zones[1].prompt_line, 5);
    }

    #[test]
    fn test_cwd_tracking() {
        use crate::osc::{OscEvent, OscEventKind};
        let (mut engine, _buf) = TerminalEngine::new(24, 80);
        assert!(engine.cwd.is_none());
        engine.apply_osc_events(
            &[OscEvent { kind: OscEventKind::WorkingDirectory("/tmp".to_string()) }],
            0, 0,
        );
        assert_eq!(engine.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn test_engine_new_returns_tuple() {
        let (engine, buf) = TerminalEngine::new(24, 80);
        assert_eq!(engine.rows, 24);
        assert_eq!(engine.cols, 80);
        assert!(engine.zones.is_empty());
        assert!(engine.cwd.is_none());
        assert!(buf.lock().is_empty());
    }
}
