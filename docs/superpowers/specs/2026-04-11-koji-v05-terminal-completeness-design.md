# Kōji Baseline v0.5 — Terminal Completeness

## Goal

Make Kōji a fully functional modern terminal where vim, htop, tmux, and Claude Code work correctly. Add alternate screen buffer, Alt/Meta key routing, full mouse reporting with SGR encoding, scrollback search, complete ANSI attribute rendering, OSC sequence handling, bell feedback, clickable URLs, and configurable cursor styles. All new UI elements match the existing theme system (Wallace, Tyrell, Baseline, Netrunner, Arasaka, Militech).

## Features

### 1. Alternate Screen Buffer

alacritty_terminal maintains two grid buffers internally and swaps between them when apps send `\e[?1049h` (enter) / `\e[?1049l` (leave). Kōji currently doesn't distinguish between them.

**Changes:**
- Add `is_alt_screen: bool` to `GridSnapshot` (Rust), set from `self.term.mode().contains(TermMode::ALT_SCREEN)`.
- Frontend: when `is_alt_screen` flips true, hide all scrollback rows and display only viewport rows. When it flips back, restore scrollback rows.
- Transition is instant — no animation.
- Scrollback is not modified when entering/leaving alt screen — it's preserved and restored.

**Unlocks:** vim, less, htop, top, man, nano, any curses/ncurses application.

### 2. Alt/Option Key as Meta

Currently `keyToAnsi()` ignores `altKey`. Readline shells use Alt as Meta for word navigation.

**Changes:**
- Extract `altKey` from keyboard events.
- When `altKey` is true and a printable key is pressed, send `\x1b` + the key character (ESC prefix = Meta). Example: Alt+B → `\x1b b`.
- Alt+Backspace → `\x1b\x7f` (Meta-Backspace = delete word backward).
- macOS-specific: Option generates composed characters (Option+B = `∫`). Use `event.code` to get the underlying key letter, not the composed `event.key`.
- Config option `option_as_meta: true` (default true). Users who need Option for special characters can toggle it off.

**Unlocks:** Alt+B (word back), Alt+F (word forward), Alt+D (delete word), Alt+. (last argument), Alt+Backspace (delete word back).

### 3. Mouse Reporting with SGR Encoding

When a terminal app requests mouse tracking, the terminal forwards mouse events to the PTY as escape sequences instead of doing native selection.

**Changes:**
- **Rust**: Add `mouse_mode` flags to `GridSnapshot`, read from `TermMode` — report which modes are active: `MOUSE_REPORT_CLICK` (1000), `MOUSE_REPORT_DRAG` (1002), `MOUSE_REPORT_MOTION` (1003), `SGR_MOUSE` (1006).
- **Frontend mouse handler**: When any mouse mode is active, intercept mousedown/mouseup/mousemove/wheel on the grid and convert to SGR escape sequences:
  - Press: `\e[<button;col;row M`
  - Release: `\e[<button;col;row m`
  - Button encoding: 0=left, 1=middle, 2=right, 64=scroll-up, 65=scroll-down. Add 32 for motion events. Add modifier bits (4=shift, 8=meta, 16=ctrl).
- **Mode switching**: Mouse mode OFF (default) = native browser selection works as now. Mouse mode ON = events go to PTY. Hold Shift to force native selection even in mouse mode (standard terminal convention).
- **Scroll wheel**: Mouse mode active → scroll events go to PTY. Inactive → native scrollback.
- Grid cell coordinates calculated from `getBoundingClientRect()` on grid cells.

**Unlocks:** tmux mouse mode, vim mouse clicks/scroll, Midnight Commander, any TUI mouse support.

### 4. Search Scrollback (Cmd+F) and Clear Scrollback (Cmd+K)

**Search:**
- Cmd+F opens a floating search bar at the top-right of the terminal viewport.
- UI: dark panel (`rgba(15,15,15,0.96)`), text input, match count display (`3 of 17`), up/down navigation, close button.
- Themed: border `--koji-dim`, input text `--koji-bright`, match count `--koji-faded`.
- Matches highlighted in grid: matching cell spans get `.search-match` class with `--koji-orange` at 20% opacity background. Active match gets `.search-match-active` at 40% opacity.
- Search scans `textContent` across all row elements (viewport + scrollback). Matches stored as `{row, colStart, colEnd}` ranges.
- Enter / Down arrow → next match. Shift+Enter / Up arrow → previous match. Auto-scrolls match into view.
- Escape closes the bar and clears all highlights.
- Case-insensitive by default. Could add a toggle button for case-sensitive/regex later.

**Clear Scrollback:**
- Cmd+K removes all scrollback DOM rows, resets the scrollback array, sends `\e[2J\e[H` (clear screen + home cursor) to PTY.
- Instant, no confirmation.

### 5. Complete ANSI Attributes

Currently supported: bold, italic, underline, dim, inverse. Adding:

- **Strikethrough** (`\e[9m`): Add `strikethrough: bool` to `RenderCell`. Check `Flags::STRIKETHROUGH` in `cell_to_render()`. Render as `text-decoration: line-through`. Combines with underline: `text-decoration: underline line-through`.
- **Hidden/Invisible** (`\e[8m`): Add `hidden: bool` to `RenderCell`. Check `Flags::HIDDEN`. Render as `visibility: hidden` — cell occupies space, text invisible. Passwords and `read -s` work correctly.
- **Blink** (`\e[5m`): Add `blink: bool` to `RenderCell`. Check `Flags::BLINK`. CSS `@keyframes cell-blink` toggles opacity between 1.0 and 0.3 on a 1-second cycle.

All three are pure data flow: Rust extracts flag → serializes in snapshot → frontend applies CSS.

### 6. OSC Sequences

- **OSC 0/1/2 — Window title**: Add `title: Option<String>` to `GridSnapshot` (or emit a separate `title-changed` event). Read from alacritty_terminal's title. Frontend updates `document.title` and calls Tauri `appWindow.setTitle()`. The dashboard-top could optionally display it.
- **OSC 8 — Hyperlinks**: If alacritty_terminal 0.25.1 exposes hyperlink data on cells, extract URL and attach as `data-href` attribute on cell spans. If not supported in this version, rely on regex URL detection from `clickable.ts` instead. Either path results in clickable URLs.
- **OSC 52 — Clipboard write**: Allow terminal apps to write to the system clipboard. Write-only — read requests are denied (security). Detect OSC 52 from alacritty_terminal events, decode base64 payload, call `navigator.clipboard.writeText()`.
- **OSC 7 — Current working directory**: If alacritty_terminal exposes it, use it to update CWD tracking (more accurate than polling). Otherwise the existing `monitor.rs` polling continues to work.

### 7. Bell

- **Visual bell**: On BEL (`\x07`), apply `effect-bell` CSS class to `.terminal-grid` — a brief soft amber flash, 150ms duration. Uses the same CSS animation pattern as existing command effects. Always on.
- **Dock bounce**: Call Tauri `appWindow.requestUserAttention()` when the window is not focused and BEL is received. Off by default. Config key `bell_dock_bounce: false`.
- **Detection**: Hook into alacritty_terminal's bell event (the library fires a bell callback), or detect BEL in the byte stream. Emit a `terminal-bell` Tauri event from the I/O thread.

### 8. Clickable URLs and Paths (Re-enable)

Adapt existing `clickable.ts` for the DOM grid:

- Scan row `textContent` after render using existing URL/path regex patterns.
- On hover: add `.clickable-hover` class to matching cell spans — underline in `--koji-orange`, cursor changes to pointer.
- On click: `invoke("open_url")` for URLs, `invoke("open_file")` for files, write `cd <dir>\r` to PTY for directories.
- Debounced detection: 200ms after last `terminal-output` event, scan visible rows.
- When mouse reporting is active (app requested mouse tracking), clickable detection is paused — mouse events go to PTY instead.
- When mouse reporting is inactive, clickable detection works as described.

### 9. Cursor Styles

Three styles, user-configurable, persisting in config:

- **Block** (default): `.cell--cursor-block` — `background: var(--koji-bright); color: var(--koji-void)`. Character visible inside colored rectangle.
- **Beam**: `.cell--cursor-beam` — `border-left: 3px solid var(--koji-bright)`. Current v0.4 style.
- **Underline**: `.cell--cursor-underline` — `border-bottom: 2px solid var(--koji-bright)`.

All three blink via CSS `@keyframes`, targeting different properties per style.

**Commands:**
- `/cursor` — interactive picker (MenuResult pattern, same as `/font` and `/theme`).
- `/cursor block|beam|underline` — direct set.
- Config key: `cursor_style: "block"`.

## Config Schema

New keys added to `~/.koji-baseline/config.json`:

```json
{
  "cursor_style": "block",
  "option_as_meta": true,
  "bell_dock_bounce": false
}
```

## Theme Integration

All new UI elements use existing CSS custom properties:
- Search bar: `--koji-void` background, `--koji-dim` border, `--koji-bright` input text, `--koji-orange` match highlights
- Bell flash: `--koji-orange` at low opacity (same as command-flash)
- Clickable hover: `--koji-orange` underline
- Cursor styles: `--koji-bright` for all three styles, `--koji-void` for block cursor text
- Blink animation: `--koji-bright` opacity cycle

Theme switching applies to all new elements automatically via CSS custom properties. No hardcoded colors.

## Files Changed

### New Files
- `src/terminal/search.ts` — Search bar UI, match scanning, highlight management
- `src/terminal/mouse.ts` — Mouse reporting, SGR encoding, mode tracking

### Modified Files (Rust)
- `src-tauri/src/terminal.rs` — Add `is_alt_screen`, `mouse_mode`, `title`, `strikethrough`, `hidden`, `blink` to GridSnapshot/RenderCell. Add bell event detection.
- `src-tauri/src/lib.rs` — Emit `terminal-bell` and `title-changed` events from I/O thread.

### Modified Files (TypeScript)
- `src/main.ts` — Alt key routing in `keyToAnsi()`, Cmd+F/Cmd+K bindings, mouse event handler delegation, bell listener, alt screen toggle.
- `src/terminal/dom-grid.ts` — Alt screen show/hide scrollback, search highlight class application, mouse coordinate helpers.
- `src/terminal/clickable.ts` — Adapt for DOM grid (was Canvas-based), add hover/click handlers.
- `src/commands/handlers.ts` — Add `/cursor` command handler.
- `src/commands/router.ts` — Register `/cursor` route.
- `src/animation/effects.ts` — Add `bell()` method (CSS class toggle).

### Modified Files (CSS)
- `src/styles/wallace.css` — Search bar styles, cursor style variants (block/beam/underline), blink text animation, bell flash animation, clickable hover styles, search match highlights.

## Testing

- Alt screen: `vim testfile`, `:q` — content should swap and restore cleanly.
- Alt key: type `Alt+B` and `Alt+F` in a zsh prompt — cursor should jump words.
- Mouse: `tmux` with `set -g mouse on`, click panes, scroll, drag-select.
- Search: `seq 1 1000`, then Cmd+F, search "500" — should highlight and scroll to match.
- Clear: Cmd+K — scrollback gone, fresh screen.
- Strikethrough: `echo -e "\e[9mstrikethrough\e[0m"` — text should have line through it.
- Hidden: `echo -e "\e[8mhidden\e[0m"` — text invisible but space occupied.
- Blink: `echo -e "\e[5mblink\e[0m"` — text should pulse.
- Bell: `echo -e "\a"` — grid should flash briefly.
- URLs: `echo "https://github.com"` — hover should underline, click should open browser.
- Cursor: `/cursor block`, `/cursor beam`, `/cursor underline` — cursor appearance changes.
