# Kōji Baseline v0.4 — Terminal Quality Pivot

## Goal

Strip aesthetic novelty, rebuild the terminal rendering core for speed, stability, and modern terminal ergonomics. Replace the Canvas 2D grid with a DOM-based grid to unlock native text selection, ligatures, emoji, CJK support, and smooth scrollback. Remove the waveform animation. Add a curated font system, full clipboard integration, and a strict performance budget.

## Architecture

### Rendering Pipeline

```
PTY bytes (shell output)
    ↓
alacritty_terminal (VTE parser, Rust)
    ↓
GridSnapshot JSON — viewport rows + scrollback-append events
    ↓
DOM Grid Renderer (TypeScript)
    ↓
Row-level diff (content hash per row, skip unchanged)
Cell-level cursor update (2 DOM ops max)
Frame batching (only render latest snapshot per rAF)
    ↓
<div class="terminal-grid">
  <div class="grid-scroll">        ← overflow-y: auto, smooth scroll
    <div class="grid-row">          ← one per terminal line
      <span class="cell">char</span> ← one per cell, styled inline (fg, bg, bold, etc.)
    </div>
  </div>
</div>
```

### DOM Grid Structure

The terminal viewport contains a single scroll container (`grid-scroll`) holding all rows — both scrollback history and the current viewport. Each row is a `<div class="grid-row">` containing `<span class="cell">` elements.

- **Normal cells**: single `<span>` per column, `width: 1ch`
- **Wide cells** (CJK, emoji): single `<span class="cell wide">`, `width: 2ch`, next cell (WIDE_CHAR_SPACER) is skipped
- **Cursor**: CSS class `cell--cursor` on the active cell, blink via CSS `@keyframes` animation (no JS)

Row DOM nodes are pre-created on init and recycled. When scrollback exceeds the configured limit, oldest rows are removed from the DOM.

### Diffing Strategy

**Row-level diffing**: Each row maintains a content hash — a fast string concatenation of `char+fg+bg+flags` for every cell in the row. On each new GridSnapshot from Rust, compare the new hash against the stored hash. Changed rows get their `innerHTML` rebuilt. Unchanged rows are skipped entirely. In a typical frame during interactive use, 2-5 rows change.

**Cell-level cursor**: Cursor position is tracked separately. On cursor move: remove the `cell--cursor` class from the old cell, add it to the new cell. Two DOM operations maximum. Cursor blink is a CSS animation — zero JavaScript cost.

**Frame batching**: During heavy PTY output (e.g. `cat` a large file), multiple GridSnapshot events can arrive within a single animation frame. A flag marks the latest snapshot as pending; a single `requestAnimationFrame` callback processes only the most recent one, dropping intermediate frames. The user sees the final result without DOM thrash.

## Removals

### Waveform Animation
Remove entirely: `src/animation/waveform.ts`, `#waveform-top`, `#waveform-bottom` DOM elements, associated CSS, CPU-coupling listener in `main.ts`. The terminal viewport expands to fill the recovered space. CPU percentage data remains available in the status bar.

### Canvas Scan Line (Idle Animation)
Remove the idle scan line effect from `src/ascii/idle.ts`. The kanji character cycling remains — it updates a DOM element on a `setInterval(800ms)` and costs nothing.

### Canvas Grid Renderer
Remove the Canvas 2D rendering pipeline in `src/terminal/grid.ts`. Replace with the DOM grid renderer. The `scrollback.ts` fade effect (Canvas-specific) is also removed.

### Scrollback Fade
The Canvas-based scrollback dimming effect (`applyScrollbackFade`) is removed. The DOM grid does not replicate this — all rows render at full brightness. If ambient dimming is desired later, it could be added as a CSS gradient overlay, but it is out of scope for v0.4.

## Font System

### Curated Font Lineup

Four bundled monospace fonts, all with ligature support, chosen for readability and aesthetic fit with the Kōji themes:

1. **JetBrains Mono** (default) — Designed for code. Tall x-height, clear glyph distinction (0/O, 1/l/I). 138 ligatures. Already bundled.
2. **Fira Code** — The original ligature font. Slightly rounder than JetBrains. Warm character that fits the amber Wallace palette.
3. **Cascadia Code** — Microsoft's terminal font. Clean, modern, slightly condensed. Good contrast at small sizes.
4. **Iosevka** — Narrow and elegant. Fits more columns in the same width. Has a sci-fi quality matching the BR2049 aesthetic.

Fonts are bundled as WOFF2 files in the app and loaded via `@font-face`. No external font downloads.

### Fallback Chain

```css
font-family: '<selected-font>', 'Apple Color Emoji', 'Hiragino Sans', 'Noto Sans CJK SC', monospace;
```

1. Selected font — ligatures, Latin, symbols
2. Apple Color Emoji — emoji rendering (macOS native)
3. Hiragino Sans / Noto Sans CJK SC — Japanese, Chinese, Korean
4. monospace — system fallback

### Font Controls

- **`/font` command** — Interactive picker menu (same pattern as `/theme`). Shows font name with a live preview line.
- **Cmd+Plus / Cmd+Minus** — Increase/decrease font size by 1px. Range: 10px–24px. Grid recalculates rows and columns on change. Persisted in config.
- **Ligature toggle** — Setting in `~/.koji-baseline/config.json`. Applies `font-variant-ligatures: normal` (on) or `font-variant-ligatures: none` (off). Default: on.

### Wide Character Handling

alacritty_terminal marks cells with `WIDE` and `WIDE_CHAR_SPACER` flags. The DOM renderer handles these:

- `WIDE` cell → `<span class="cell wide">` with `width: 2ch`, renders the character
- `WIDE_CHAR_SPACER` cell → skipped (consumed by the preceding wide cell)

This keeps the grid aligned for CJK characters and emoji without breaking column layout.

## Scrollback

### Buffer

- **Default**: 10,000 lines
- **Configurable** via `~/.koji-baseline/config.json` (`scrollback_lines` key)
- **Enforcement**: frontend trims oldest DOM rows when count exceeds the limit
- alacritty_terminal's internal scrollback configured to match via `TermConfig`

### Rust Backend Changes

Currently `snapshot()` only sends visible viewport rows. For v0.4:

- New Tauri event: `scrollback-append` — emitted when lines scroll off the top of the viewport. Carries the row data for the line(s) that just left the viewport.
- `terminal-output` event continues to carry the current viewport snapshot (as now).
- On initial terminal load, send existing scrollback content so the frontend can populate history.

### Smooth Scrolling

- **Trackpad**: Native CSS `scroll-behavior: smooth` on `grid-scroll`. macOS momentum scrolling works automatically.
- **Keyboard**:
  - `Shift+PageUp/PageDown` — scroll by viewport height
  - `Shift+Up/Down` — scroll by single line
  - `Shift+Home/End` — jump to top/bottom of scrollback
- **Auto-scroll**: New output auto-scrolls to bottom unless the user has scrolled up. While scrolled up, new output appends below without yanking the viewport. Scrolling back to the bottom re-enables auto-scroll.

### Scrollbar

- 6px wide, rounded corners
- Track: transparent
- Thumb: theme accent color at 40% opacity
- Fades to transparent after 1.5 seconds of no scroll activity
- Appears on hover over the right edge or during active scrolling
- Styled via `::-webkit-scrollbar` pseudo-elements (WebKit/Blink engine in Tauri's webview)

## Selection & Clipboard

### Mouse Selection

DOM-based grid provides native browser selection for free:

- **Click + drag** — select text range
- **Double-click** — select word
- **Triple-click** — select full line
- **Shift+click** — extend existing selection

Selection highlight styled via `::selection` pseudo-element: theme accent color at 25% opacity.

### Copy

- **Cmd+C** — Smart behaviour: if text is selected, copy it to clipboard. If nothing is selected, send `^C` (SIGINT) to the PTY. This is the standard terminal convention (iTerm2, Alacritty, WezTerm all do this).
- **Copy-on-select** — When mouse button is released after a selection, automatically copy selected text to clipboard. Enabled by default, toggleable in config (`copy_on_select: true/false`).

### Paste

- **Cmd+V** — Read text from system clipboard, wrap in bracketed paste escape sequences (`\e[200~`...`\e[201~`), write to PTY.
- **Middle-click** — Same as Cmd+V. Standard terminal convention for X11/Linux users, also useful on macOS with a three-button mouse.
- **Bracketed paste** — Always enabled. Prevents accidental execution of multi-line pasted content by signalling to the shell that the input is pasted, not typed.

## Performance

### Targets

| Metric | Target | Method |
|--------|--------|--------|
| Frame render | < 4ms | Row-level diffing, only touch changed DOM rows |
| Idle CPU | < 1% | CSS cursor blink (no JS), kanji on setInterval only |
| Memory baseline | < 80MB | DOM nodes recycled, scrollback capped at 10k lines |
| Heavy output (`cat bigfile`) | No jank | Frame batching — render only latest snapshot per rAF |
| Resize | < 16ms | Debounced 50ms, recalculate rows/cols, notify PTY |
| RAF loops at idle | 0 | Cursor = CSS, grid = event-driven, kanji = setInterval |

### Animation Consolidation

v0.3 ran three separate `requestAnimationFrame` loops simultaneously (cursor blink, grid render, idle scan line). v0.4 eliminates all of them:

- **Cursor blink** → CSS `@keyframes` animation on `.cell--cursor`. Zero JavaScript.
- **Grid render** → Event-driven. Runs only when a `terminal-output` event arrives from the Rust backend. Frame-batched via a single rAF gate.
- **Kanji idle cycle** → `setInterval(800ms)`. Starts after 30 seconds idle, stops on any keypress. No rAF needed for 800ms updates.

Result: at idle, zero animation frames are requested. The browser's compositor handles the cursor blink natively.

## Config Schema

All new settings persist in `~/.koji-baseline/config.json` alongside existing theme and model settings:

```json
{
  "theme": "wallace",
  "font": "JetBrains Mono",
  "font_size": 14,
  "ligatures": true,
  "copy_on_select": true,
  "scrollback_lines": 10000
}
```

## Files Changed

### New Files
- `src/terminal/dom-grid.ts` — DOM grid renderer (replaces Canvas grid.ts)
- `src/terminal/selection.ts` — Selection management, copy-on-select, smart Cmd+C
- `src/terminal/scrollback-manager.ts` — Scrollback buffer, auto-scroll, DOM trimming
- `src/fonts/fonts.ts` — Font loader, picker, size controls
- Font files: `src/fonts/woff2/FiraCode-Regular.woff2`, `CascadiaCode-Regular.woff2`, `Iosevka-Regular.woff2` (JetBrains Mono already bundled)

### Modified Files
- `src/main.ts` — Replace Canvas grid init with DOM grid, wire scrollback-append listener, add keyboard shortcuts (font size, scroll), remove waveform wiring
- `src/styles/wallace.css` — Remove waveform CSS, add DOM grid styles, scrollbar styles, selection styles, font-face declarations
- `index.html` — Remove `#waveform-top`, `#waveform-bottom` divs, replace Canvas with DOM grid container
- `src-tauri/src/terminal.rs` — Add `scrollback-append` event emission, configure max scrollback lines, expose scrollback on init
- `src-tauri/src/lib.rs` — Add font-size/scrollback config commands if needed
- `src/commands/handlers.ts` — Add `/font` command handler
- `src/commands/router.ts` — Register `/font` command
- `src/ascii/idle.ts` — Remove scan line rendering, keep kanji cycling, switch from RAF to setInterval
- `src/animation/effects.ts` — Rewrite as CSS transitions: command submit sweep becomes a brief CSS flash on `.terminal-grid`, completion pulse becomes a row highlight fade, error flicker becomes a CSS animation on affected rows. All three effects are short-lived class toggles with CSS `@keyframes`, no JS animation loops.

### Removed Files
- `src/terminal/grid.ts` — Canvas 2D renderer (replaced by dom-grid.ts)
- `src/terminal/scrollback.ts` — Canvas scrollback fade effect
- `src/animation/waveform.ts` — Waveform animator

## Testing Approach

- Verify TrueColor: run `scripts/truecolor-test.sh` (standard 24-bit color gradient test) — should render smooth gradients
- Verify emoji/CJK: `echo "🔥光路影幻🎌"` — characters should align to grid without overlap
- Verify ligatures: `echo "=> -> !== ==="` in a JS file — should render combined glyphs when ligatures enabled
- Verify selection: click-drag across terminal output, Cmd+C, paste into external app
- Verify scrollback: `seq 1 20000` — scroll up with trackpad, verify smooth scroll and auto-scroll resume
- Verify performance: `cat /usr/share/dict/words` — should render without dropped frames or jank
- Verify resize: drag window edges — grid should recalculate cleanly without artifacts
