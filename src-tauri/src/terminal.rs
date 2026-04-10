// terminal.rs — Terminal Engine: VTE parser + grid snapshot → JSON-serializable state
// alacritty_terminal wraps the hard bits; we dress the output in whatever theme is active.

use alacritty_terminal::Term;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::Config as TermConfig;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Rgb};
use alacritty_terminal::term::cell::Flags;
use serde::Serialize;
use std::collections::HashMap;

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
    }
}

// ─── TerminalEngine ───────────────────────────────────────────────────────────

/// Owns the Term + VTE Processor. Feed it raw PTY bytes; snapshot the grid whenever.
pub struct TerminalEngine {
    term: Term<VoidListener>,
    parser: Processor,
    rows: usize,
    cols: usize,
    /// Runtime theme overrides — maps colour key (e.g. "red") → RGB triple.
    /// Empty = use Wallace defaults. Populated by set_theme_colors().
    pub color_overrides: HashMap<String, [u8; 3]>,
}

impl TerminalEngine {
    pub fn new(rows: usize, cols: usize) -> Self {
        let size = TermSize::new(cols, rows);
        let config = TermConfig::default();
        let term = Term::new(config, &size, VoidListener);
        let parser = Processor::new();

        Self { term, parser, rows, cols, color_overrides: HashMap::new() }
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

        GridSnapshot {
            cells,
            cursor: CursorPos { row: cursor_row, col: cursor_col },
            rows: self.rows,
            cols: self.cols,
        }
    }

    /// Resize the terminal. Kicks alacritty's reflow logic.
    pub fn resize(&mut self, rows: usize, cols: usize) {
        self.rows = rows;
        self.cols = cols;
        let size = TermSize::new(cols, rows);
        self.term.resize(size);
    }
}
