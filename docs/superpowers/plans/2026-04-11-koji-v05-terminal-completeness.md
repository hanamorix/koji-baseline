# Kōji Baseline v0.5 — Terminal Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kōji a fully functional modern terminal — alternate screen buffer for vim/htop, Alt key as Meta for readline, full SGR mouse reporting, scrollback search, complete ANSI attributes, OSC sequences, bell feedback, clickable URLs, and configurable cursor styles.

**Architecture:** Most features flow through the same pipeline: Rust extracts data from alacritty_terminal → adds fields to GridSnapshot → emits via Tauri IPC → frontend reads and renders. Mouse reporting reverses this: frontend captures mouse → encodes SGR sequences → writes to PTY. Search and cursor styles are frontend-only. All UI elements use CSS custom properties from the theme system.

**Tech Stack:** Rust (alacritty_terminal flags/modes, Tauri events), TypeScript (DOM grid rendering, mouse encoding, search UI), CSS (cursor styles, animations, search highlights).

**Spec:** `docs/superpowers/specs/2026-04-11-koji-v05-terminal-completeness-design.md`

**Project location:** `/Users/hanamori/koji-baseline/`

---

## Phase 1: Terminal Protocol (Tasks 1-3)

### Task 1: Alternate Screen Buffer

**Files:**
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add `is_alt_screen` to GridSnapshot in terminal.rs**

In `src-tauri/src/terminal.rs`, add the import for TermMode at the top (around line 4):

```rust
use alacritty_terminal::term::TermMode;
```

Add the field to `GridSnapshot` (after line 39):

```rust
#[derive(Debug, Clone, Serialize)]
pub struct GridSnapshot {
    pub cells: Vec<Vec<RenderCell>>,
    pub cursor: CursorPos,
    pub rows: usize,
    pub cols: usize,
    pub is_alt_screen: bool,
}
```

In the `snapshot()` method (around line 258), set the new field:

```rust
GridSnapshot {
    cells,
    cursor: CursorPos { row: cursor_row, col: cursor_col },
    rows: self.rows,
    cols: self.cols,
    is_alt_screen: self.term.mode().contains(TermMode::ALT_SCREEN),
}
```

- [ ] **Step 2: Add `is_alt_screen` to TypeScript GridSnapshot interface**

In `src/terminal/dom-grid.ts`, update the `GridSnapshot` interface (around line 20):

```typescript
export interface GridSnapshot {
  cells: RenderCell[][];
  cursor: CursorPos;
  rows: number;
  cols: number;
  is_alt_screen: boolean;
}
```

- [ ] **Step 3: Handle alt screen toggle in DOMGrid**

In `src/terminal/dom-grid.ts`, add a field to the `DOMGrid` class:

```typescript
private inAltScreen = false;
```

In the `renderImmediate` method (around line 279), add alt screen handling before the row-level diffing:

```typescript
private renderImmediate(snapshot: GridSnapshot): void {
  this.lastSnapshot = snapshot;

  // Alt screen toggle — hide/show scrollback
  if (snapshot.is_alt_screen !== this.inAltScreen) {
    this.inAltScreen = snapshot.is_alt_screen;
    for (const row of this.scrollbackRows) {
      row.style.display = this.inAltScreen ? "none" : "";
    }
  }

  // Ensure correct row count
  if (this.viewportRows.length !== snapshot.rows) {
    this.resize(snapshot.rows, snapshot.cols);
  }

  // Row-level diffing (existing code continues...)
```

Also update `appendScrollback` to respect alt screen — don't show new scrollback rows if in alt screen:

In the `appendScrollback` method, after creating each `el`:

```typescript
if (this.inAltScreen) {
  el.style.display = "none";
}
```

- [ ] **Step 4: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: alternate screen buffer — vim, less, htop now work correctly"
```

---

### Task 2: Alt/Option Key as Meta

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add Alt key handling to keyToAnsi**

In `src/main.ts`, update the `keyToAnsi` function (around line 382). Change the signature to extract `altKey`:

```typescript
function keyToAnsi(event: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey } = event;

  // Alt/Option as Meta — send ESC prefix + key
  if (altKey && !ctrlKey && !event.metaKey) {
    if (key === "Backspace") return "\x1b\x7f"; // Meta-Backspace = delete word back
    if (key.length === 1) {
      // Use the raw key letter, not composed character (macOS Option produces special chars)
      const rawKey = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : key;
      return "\x1b" + rawKey;
    }
  }

  // Ctrl+key combos (existing code...)
  if (ctrlKey && key.length === 1) {
    const code = key.toLowerCase().charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) {
      return String.fromCharCode(code);
    }
  }

  // ... rest of switch statement unchanged
```

- [ ] **Step 2: Load option_as_meta config**

In `src/main.ts`, add a config flag near the top of the keyboard handler setup (after the autocomplete init):

```typescript
let optionAsMeta = true;
invoke("load_config", { key: "option_as_meta" }).then((val: unknown) => {
  if (val === "false") optionAsMeta = false;
}).catch(() => {});
```

Then wrap the Alt key handling in `keyToAnsi` with this flag:

```typescript
  if (optionAsMeta && altKey && !ctrlKey && !event.metaKey) {
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Alt/Option key as Meta — Alt+B/F word nav, Alt+D word delete"
```

---

### Task 3: Mouse Reporting with SGR Encoding

**Files:**
- Create: `src/terminal/mouse.ts`
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/main.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add mouse mode flags to GridSnapshot in Rust**

In `src-tauri/src/terminal.rs`, add mouse mode fields to `GridSnapshot`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct GridSnapshot {
    pub cells: Vec<Vec<RenderCell>>,
    pub cursor: CursorPos,
    pub rows: usize,
    pub cols: usize,
    pub is_alt_screen: bool,
    pub mouse_mode: u8,
}
```

In the `snapshot()` method, calculate mouse mode from TermMode:

```rust
let mode = self.term.mode();
let mouse_mode = {
    let mut m: u8 = 0;
    if mode.contains(TermMode::MOUSE_REPORT_CLICK) { m |= 1; }
    if mode.contains(TermMode::MOUSE_DRAG) { m |= 2; }
    if mode.contains(TermMode::MOUSE_MOTION) { m |= 4; }
    if mode.contains(TermMode::SGR_MOUSE) { m |= 8; }
    m
};

GridSnapshot {
    cells,
    cursor: CursorPos { row: cursor_row, col: cursor_col },
    rows: self.rows,
    cols: self.cols,
    is_alt_screen: mode.contains(TermMode::ALT_SCREEN),
    mouse_mode,
}
```

Note: Check the exact flag names in alacritty_terminal 0.25.1's `TermMode`. They may be `MOUSE_REPORT_CLICK`, `MOUSE_DRAG`, `MOUSE_MOTION`, `SGR_MOUSE` or similar. If names differ, adapt accordingly.

- [ ] **Step 2: Update TypeScript GridSnapshot**

In `src/terminal/dom-grid.ts`, add the field:

```typescript
export interface GridSnapshot {
  cells: RenderCell[][];
  cursor: CursorPos;
  rows: number;
  cols: number;
  is_alt_screen: boolean;
  mouse_mode: number;
}
```

Add a public method to DOMGrid to expose the current mouse mode:

```typescript
getMouseMode(): number {
  return this.lastSnapshot?.mouse_mode ?? 0;
}
```

Also add a helper to calculate cell coordinates from a mouse event:

```typescript
getCellFromMouse(event: MouseEvent): { row: number; col: number } | null {
  const gridRect = this.gridEl.getBoundingClientRect();
  const x = event.clientX - gridRect.left;
  const y = event.clientY - gridRect.top + this.scrollEl.scrollTop;

  // Find which row
  for (let r = 0; r < this.viewportRows.length; r++) {
    const rowEl = this.viewportRows[r].el;
    const rowRect = rowEl.getBoundingClientRect();
    if (event.clientY >= rowRect.top && event.clientY < rowRect.bottom) {
      // Find which column
      for (let c = 0; c < rowEl.children.length; c++) {
        const cellRect = (rowEl.children[c] as HTMLElement).getBoundingClientRect();
        if (event.clientX >= cellRect.left && event.clientX < cellRect.right) {
          return { row: r, col: c };
        }
      }
      // Past last cell — use last column
      return { row: r, col: rowEl.children.length - 1 };
    }
  }
  return null;
}
```

- [ ] **Step 3: Create mouse.ts**

Create `src/terminal/mouse.ts`:

```typescript
// mouse.ts — Terminal mouse reporting with SGR encoding

import { invoke } from "@tauri-apps/api/core";
import type { DOMGrid } from "./dom-grid";

export class MouseReporter {
  private grid: DOMGrid;
  private gridEl: HTMLElement;
  private active = false;
  private lastButton = -1;

  constructor(grid: DOMGrid) {
    this.grid = grid;
    this.gridEl = grid.getGridElement();
    this.setupListeners();
  }

  /** Check snapshot mouse_mode and enable/disable reporting. */
  updateMode(mouseMode: number): void {
    const shouldBeActive = mouseMode > 0;
    if (shouldBeActive !== this.active) {
      this.active = shouldBeActive;
      // When mouse mode activates, disable native text selection
      this.gridEl.style.userSelect = this.active ? "none" : "";
    }
  }

  private setupListeners(): void {
    this.gridEl.addEventListener("mousedown", (e) => {
      if (!this.active || e.shiftKey) return; // Shift = force native selection
      e.preventDefault();
      const pos = this.grid.getCellFromMouse(e);
      if (!pos) return;
      this.lastButton = e.button;
      this.sendSGR(e.button, pos.col, pos.row, "M", e);
    });

    this.gridEl.addEventListener("mouseup", (e) => {
      if (!this.active || e.shiftKey) return;
      e.preventDefault();
      const pos = this.grid.getCellFromMouse(e);
      if (!pos) return;
      this.sendSGR(e.button, pos.col, pos.row, "m", e);
      this.lastButton = -1;
    });

    this.gridEl.addEventListener("mousemove", (e) => {
      if (!this.active || e.shiftKey) return;
      const mode = this.grid.getMouseMode();
      const isDrag = (mode & 2) !== 0;
      const isMotion = (mode & 4) !== 0;

      if (this.lastButton >= 0 && isDrag) {
        const pos = this.grid.getCellFromMouse(e);
        if (!pos) return;
        this.sendSGR(this.lastButton + 32, pos.col, pos.row, "M", e);
      } else if (isMotion) {
        const pos = this.grid.getCellFromMouse(e);
        if (!pos) return;
        this.sendSGR(35, pos.col, pos.row, "M", e); // 35 = no button + motion
      }
    });

    this.gridEl.addEventListener("wheel", (e) => {
      if (!this.active || e.shiftKey) return;
      e.preventDefault();
      const pos = this.grid.getCellFromMouse(e);
      if (!pos) return;
      const button = e.deltaY < 0 ? 64 : 65; // 64=scroll up, 65=scroll down
      this.sendSGR(button, pos.col, pos.row, "M", e);
    });
  }

  private sendSGR(button: number, col: number, row: number, suffix: "M" | "m", e: MouseEvent): void {
    // Add modifier bits
    let btn = button;
    if (e.shiftKey) btn |= 4;
    if (e.altKey) btn |= 8;
    if (e.ctrlKey) btn |= 16;

    // SGR encoding: \e[<btn;col;row M (1-indexed)
    const seq = `\x1b[<${btn};${col + 1};${row + 1}${suffix}`;
    const bytes = Array.from(new TextEncoder().encode(seq));
    invoke("write_to_pty", { data: bytes }).catch(console.error);
  }
}
```

- [ ] **Step 4: Wire mouse reporter in main.ts**

In `src/main.ts`, add import:

```typescript
import { MouseReporter } from "./terminal/mouse";
```

After DOMGrid init, create the mouse reporter:

```typescript
const mouse = new MouseReporter(domGrid);
```

In the `terminal-output` listener, update mouse mode on each snapshot:

```typescript
listen<GridSnapshot>("terminal-output", (event) => {
  domGrid.render(event.payload);
  mouse.updateMode(event.payload.mouse_mode);
}).catch((err) => {
  console.warn("terminal-output listener failed:", err);
});
```

- [ ] **Step 5: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: SGR mouse reporting — tmux, vim, and TUI mouse support"
```

---

## Phase 2: ANSI & OSC (Tasks 4-5)

### Task 4: Complete ANSI Attributes (Strikethrough, Hidden, Blink)

**Files:**
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add flags to RenderCell in Rust**

In `src-tauri/src/terminal.rs`, update `RenderCell` (around line 17):

```rust
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
```

Update `cell_to_render` (around line 156) to extract the new flags:

```rust
let bold = cell.flags.contains(Flags::BOLD);
let italic = cell.flags.contains(Flags::ITALIC);
let underline = cell.flags.contains(Flags::UNDERLINE);
let dim = cell.flags.contains(Flags::DIM);
let strikethrough = cell.flags.contains(Flags::STRIKETHROUGH);
let hidden = cell.flags.contains(Flags::HIDDEN);
let blink = cell.flags.contains(Flags::BLINK_SLOW) || cell.flags.contains(Flags::BLINK_FAST);
```

Note: Check exact flag names in alacritty_terminal 0.25.1. `STRIKETHROUGH` may be `STRIKEOUT`. `BLINK_SLOW`/`BLINK_FAST` may be `SLOW_BLINK`/`RAPID_BLINK`. Adapt accordingly.

Update the `RenderCell` construction to include new fields:

```rust
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
```

- [ ] **Step 2: Update TypeScript RenderCell interface**

In `src/terminal/dom-grid.ts`, update the interface:

```typescript
export interface RenderCell {
  character: string;
  fg: [number, number, number];
  bg: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  strikethrough?: boolean;
  hidden?: boolean;
  blink?: boolean;
  wide?: boolean;
  spacer?: boolean;
}
```

- [ ] **Step 3: Update buildRowHTML to render new flags**

In `src/terminal/dom-grid.ts`, update the `buildRowHTML` function. In the style building section:

```typescript
function buildRowHTML(cells: RenderCell[]): string {
  let html = "";
  for (const cell of cells) {
    if (cell.spacer) continue;

    const char = cell.character === " " ? "\u00A0" : escapeHTML(cell.character);
    const fg = rgbStyle(cell.fg);
    const bg = rgbStyle(cell.bg);

    let style = `color:${fg};background:${bg};`;
    if (cell.bold) style += "font-weight:bold;";
    if (cell.italic) style += "font-style:italic;";
    if (cell.dim) style += "opacity:0.5;";
    if (cell.hidden) style += "visibility:hidden;";

    // Build text-decoration
    const decorations: string[] = [];
    if (cell.underline) decorations.push("underline");
    if (cell.strikethrough) decorations.push("line-through");
    if (decorations.length > 0) style += `text-decoration:${decorations.join(" ")};`;

    const cls = cell.wide ? "cell wide" : cell.blink ? "cell cell-blink" : "cell";

    html += `<span class="${cls}" style="${style}">${char}</span>`;
  }
  return html;
}
```

- [ ] **Step 4: Update cellHash to include new flags**

In `src/terminal/dom-grid.ts`, update the `cellHash` function:

```typescript
function cellHash(cell: RenderCell): string {
  return `${cell.character}|${cell.fg[0]},${cell.fg[1]},${cell.fg[2]}|${cell.bg[0]},${cell.bg[1]},${cell.bg[2]}|${cell.bold ? 1 : 0}${cell.italic ? 1 : 0}${cell.underline ? 1 : 0}${cell.dim ? 1 : 0}${cell.wide ? 1 : 0}${cell.strikethrough ? 1 : 0}${cell.hidden ? 1 : 0}${cell.blink ? 1 : 0}`;
}
```

- [ ] **Step 5: Add blink animation CSS**

In `src/styles/wallace.css`, add after the cursor-blink keyframes:

```css
/* Blinking text */
.cell-blink {
  animation: cell-text-blink 1s step-end infinite;
}

@keyframes cell-text-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

- [ ] **Step 6: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: complete ANSI attributes — strikethrough, hidden, blink"
```

---

### Task 5: OSC Sequences and Bell

**Files:**
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/main.ts`
- Modify: `src/animation/effects.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add title to GridSnapshot and detect bell in Rust**

In `src-tauri/src/terminal.rs`, add `title` to GridSnapshot:

```rust
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
```

In the `snapshot()` method, read the title:

```rust
let title = self.term.title().to_string();
```

Note: Check if `self.term.title()` exists in alacritty_terminal 0.25.1. If not, use an empty string and skip OSC title support.

Add a bell detection method to TerminalEngine:

```rust
/// Check if a bell occurred during the last process_bytes call.
/// alacritty_terminal fires bell events through the EventListener trait.
/// Since we use VoidListener, we detect bell by scanning for \x07 in raw bytes.
pub fn check_bell(bytes: &[u8]) -> bool {
    bytes.contains(&0x07)
}
```

- [ ] **Step 2: Emit bell event from I/O thread in lib.rs**

In `src-tauri/src/lib.rs`, in the I/O thread (around line 61), after reading bytes but before processing, check for bell:

```rust
// Check for bell BEFORE processing (raw bytes)
let has_bell = terminal::TerminalEngine::check_bell(&buf[..n]);

// Process bytes (existing)
eng.process_bytes(&buf[..n]);

// ... existing scrollback and snapshot code ...

// Emit bell event if detected
if has_bell {
    let _ = app.emit("terminal-bell", ());
}
```

- [ ] **Step 3: Update TypeScript GridSnapshot**

In `src/terminal/dom-grid.ts`:

```typescript
export interface GridSnapshot {
  cells: RenderCell[][];
  cursor: CursorPos;
  rows: number;
  cols: number;
  is_alt_screen: boolean;
  mouse_mode: number;
  title: string;
}
```

- [ ] **Step 4: Add bell method to effects.ts**

In `src/animation/effects.ts`, add:

```typescript
/** Soft amber flash for terminal bell. */
bell(): void {
  this.gridEl.classList.remove("effect-bell");
  void this.gridEl.offsetWidth;
  this.gridEl.classList.add("effect-bell");
  this.gridEl.addEventListener("animationend", () => {
    this.gridEl.classList.remove("effect-bell");
  }, { once: true });
}
```

- [ ] **Step 5: Add bell CSS animation**

In `src/styles/wallace.css`, add after the existing effect animations:

```css
@keyframes bell-flash {
  0% { background: rgba(255, 140, 0, 0.04); }
  100% { background: transparent; }
}

.terminal-grid.effect-bell {
  animation: bell-flash 0.15s ease-out;
}
```

- [ ] **Step 6: Wire bell and title listeners in main.ts**

In `src/main.ts`, add bell listener after the terminal-output listener:

```typescript
// Bell — visual flash + optional dock bounce
listen("terminal-bell", () => {
  effects.bell();
  // Dock bounce if configured and window not focused
  if (!document.hasFocus()) {
    invoke("load_config", { key: "bell_dock_bounce" }).then((val: unknown) => {
      if (val === "true") {
        import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
          getCurrentWindow().requestUserAttention(2); // 2 = informational
        }).catch(() => {});
      }
    }).catch(() => {});
  }
}).catch((err) => {
  console.warn("terminal-bell listener failed:", err);
});
```

In the terminal-output listener, add title update:

```typescript
listen<GridSnapshot>("terminal-output", (event) => {
  domGrid.render(event.payload);
  mouse.updateMode(event.payload.mouse_mode);

  // Update window title if changed
  if (event.payload.title) {
    document.title = event.payload.title;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().setTitle(event.payload.title);
    }).catch(() => {});
  }
}).catch((err) => {
  console.warn("terminal-output listener failed:", err);
});
```

- [ ] **Step 7: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 8: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat: OSC title + terminal bell — visual flash and dock bounce"
```

---

## Phase 3: Search & Clear (Task 6)

### Task 6: Search Scrollback (Cmd+F) and Clear Scrollback (Cmd+K)

**Files:**
- Create: `src/terminal/search.ts`
- Modify: `src/main.ts`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add search CSS**

Append to `src/styles/wallace.css`:

```css
/* ── Search bar ──────────────────────────────────────────────────────────── */

.search-bar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  background: rgba(15, 15, 15, 0.96);
  border: 1px solid var(--koji-dim);
  border-radius: 4px;
  padding: 6px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  font-size: 12px;
}

.search-bar input {
  background: transparent;
  border: 1px solid var(--koji-deep);
  border-radius: 3px;
  color: var(--koji-bright);
  font-family: inherit;
  font-size: 12px;
  padding: 3px 8px;
  width: 200px;
  outline: none;
}

.search-bar input:focus {
  border-color: var(--koji-dim);
}

.search-bar .search-count {
  color: var(--koji-faded);
  font-size: 11px;
  min-width: 50px;
}

.search-bar button {
  background: transparent;
  border: 1px solid var(--koji-deep);
  border-radius: 3px;
  color: var(--koji-warm);
  cursor: pointer;
  padding: 2px 6px;
  font-family: inherit;
  font-size: 11px;
}

.search-bar button:hover {
  border-color: var(--koji-dim);
  color: var(--koji-bright);
}

/* Search match highlights in grid */
.search-match {
  background: rgba(255, 140, 0, 0.2) !important;
  border-radius: 1px;
}

.search-match-active {
  background: rgba(255, 140, 0, 0.4) !important;
  border-radius: 1px;
}
```

- [ ] **Step 2: Add clearScrollback method to DOMGrid**

In `src/terminal/dom-grid.ts`, add a public method:

```typescript
/** Clear all scrollback rows. */
clearScrollback(): void {
  for (const row of this.scrollbackRows) {
    row.remove();
  }
  this.scrollbackRows = [];
}
```

- [ ] **Step 3: Create search.ts**

Create `src/terminal/search.ts`:

```typescript
// search.ts — Floating search bar for terminal scrollback

import type { DOMGrid } from "./dom-grid";

interface SearchMatch {
  rowEl: HTMLDivElement;
  colStart: number;
  colEnd: number;
}

export class TerminalSearch {
  private grid: DOMGrid;
  private container: HTMLElement;
  private barEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private countEl: HTMLSpanElement | null = null;
  private matches: SearchMatch[] = [];
  private currentMatchIdx = -1;
  private highlightedSpans: HTMLElement[] = [];
  private _isOpen = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(container: HTMLElement, grid: DOMGrid) {
    this.container = container;
    this.grid = grid;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) {
      this.inputEl?.focus();
      this.inputEl?.select();
      return;
    }

    this.barEl = document.createElement("div");
    this.barEl.className = "search-bar";

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.placeholder = "Search...";

    this.countEl = document.createElement("span");
    this.countEl.className = "search-count";
    this.countEl.textContent = "";

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "▲";
    prevBtn.addEventListener("click", () => this.navigateMatch(-1));

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▼";
    nextBtn.addEventListener("click", () => this.navigateMatch(1));

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());

    this.barEl.appendChild(this.inputEl);
    this.barEl.appendChild(this.countEl);
    this.barEl.appendChild(prevBtn);
    this.barEl.appendChild(nextBtn);
    this.barEl.appendChild(closeBtn);

    this.container.appendChild(this.barEl);
    this._isOpen = true;

    // Input handler for live search
    this.inputEl.addEventListener("input", () => this.performSearch());

    // Keyboard handler (capture phase to intercept before main handler)
    this.keyHandler = (e: KeyboardEvent) => {
      if (!this._isOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          this.navigateMatch(-1);
        } else {
          this.navigateMatch(1);
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);

    setTimeout(() => this.inputEl?.focus(), 0);
  }

  close(): void {
    if (!this._isOpen) return;
    this.clearHighlights();
    if (this.barEl) {
      this.barEl.remove();
      this.barEl = null;
    }
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.inputEl = null;
    this.countEl = null;
    this.matches = [];
    this.currentMatchIdx = -1;
    this._isOpen = false;
  }

  private performSearch(): void {
    this.clearHighlights();
    const query = this.inputEl?.value.toLowerCase() ?? "";
    if (!query) {
      this.matches = [];
      this.currentMatchIdx = -1;
      if (this.countEl) this.countEl.textContent = "";
      return;
    }

    this.matches = [];

    // Scan all rows (scrollback + viewport) in the scroll container
    const scrollEl = this.grid.getScrollElement();
    const rows = scrollEl.querySelectorAll(".grid-row");

    rows.forEach((rowEl) => {
      const text = rowEl.textContent?.toLowerCase() ?? "";
      let searchPos = 0;
      let idx: number;

      while ((idx = text.indexOf(query, searchPos)) !== -1) {
        this.matches.push({
          rowEl: rowEl as HTMLDivElement,
          colStart: idx,
          colEnd: idx + query.length,
        });
        searchPos = idx + 1;
      }
    });

    // Highlight all matches
    for (const match of this.matches) {
      this.highlightMatch(match, false);
    }

    if (this.matches.length > 0) {
      this.currentMatchIdx = 0;
      this.highlightMatch(this.matches[0], true);
      this.scrollToMatch(this.matches[0]);
    }

    this.updateCount();
  }

  private navigateMatch(delta: number): void {
    if (this.matches.length === 0) return;

    // Remove active highlight from current
    if (this.currentMatchIdx >= 0) {
      this.highlightMatch(this.matches[this.currentMatchIdx], false);
    }

    this.currentMatchIdx += delta;
    if (this.currentMatchIdx < 0) this.currentMatchIdx = this.matches.length - 1;
    if (this.currentMatchIdx >= this.matches.length) this.currentMatchIdx = 0;

    this.highlightMatch(this.matches[this.currentMatchIdx], true);
    this.scrollToMatch(this.matches[this.currentMatchIdx]);
    this.updateCount();
  }

  private highlightMatch(match: SearchMatch, active: boolean): void {
    const cells = match.rowEl.querySelectorAll(".cell");
    for (let c = match.colStart; c < match.colEnd && c < cells.length; c++) {
      const cell = cells[c] as HTMLElement;
      cell.classList.remove("search-match", "search-match-active");
      cell.classList.add(active ? "search-match-active" : "search-match");
      this.highlightedSpans.push(cell);
    }
  }

  private clearHighlights(): void {
    for (const span of this.highlightedSpans) {
      span.classList.remove("search-match", "search-match-active");
    }
    this.highlightedSpans = [];
  }

  private scrollToMatch(match: SearchMatch): void {
    match.rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  private updateCount(): void {
    if (this.countEl) {
      if (this.matches.length === 0) {
        this.countEl.textContent = "No matches";
      } else {
        this.countEl.textContent = `${this.currentMatchIdx + 1} of ${this.matches.length}`;
      }
    }
  }
}
```

- [ ] **Step 4: Wire Cmd+F and Cmd+K in main.ts**

In `src/main.ts`, add import:

```typescript
import { TerminalSearch } from "./terminal/search";
```

After DOMGrid init, create search:

```typescript
const search = new TerminalSearch(domGrid.getGridElement(), domGrid);
```

In the keyboard handler, add Cmd+F and Cmd+K before the existing Cmd+V handler:

```typescript
// ── Cmd+F — search scrollback ──────────────────────────────────────────
if (metaKey && key === "f") {
  event.preventDefault();
  search.open();
  return;
}

// ── Cmd+K — clear scrollback ──────────────────────────────────────────
if (metaKey && key === "k") {
  event.preventDefault();
  domGrid.clearScrollback();
  // Send clear screen + home cursor to PTY
  const clearSeq = "\x1b[2J\x1b[H";
  const bytes = Array.from(new TextEncoder().encode(clearSeq));
  invoke("write_to_pty", { data: bytes }).catch(console.error);
  return;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: Cmd+F search scrollback, Cmd+K clear scrollback"
```

---

## Phase 4: Clickable URLs & Cursor Styles (Tasks 7-8)

### Task 7: Re-enable Clickable URLs and Paths

**Files:**
- Modify: `src/terminal/clickable.ts`
- Modify: `src/main.ts`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add clickable hover CSS**

Append to `src/styles/wallace.css`:

```css
/* ── Clickable URLs and paths ────────────────────────────────────────────── */

.cell.clickable-hover {
  text-decoration: underline;
  text-decoration-color: var(--koji-orange);
  cursor: pointer;
}
```

- [ ] **Step 2: Create DOM-adapted clickable detection and hover handler**

The existing `clickable.ts` has the detection logic but needs DOM wiring. Add a new function at the end of `src/terminal/clickable.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";

/** Apply clickable detection to DOM grid rows. Call debounced after render. */
export async function applyClickableRegions(
  scrollEl: HTMLElement,
  mouseMode: number,
): Promise<void> {
  // Don't detect when mouse reporting is active
  if (mouseMode > 0) return;

  const rows = scrollEl.querySelectorAll(".grid-row");
  const lastRows = Array.from(rows).slice(-50); // Only scan last 50 rows for performance

  for (let r = 0; r < lastRows.length; r++) {
    const rowEl = lastRows[r] as HTMLDivElement;
    if (rowEl.dataset.clickableScanned) continue;
    rowEl.dataset.clickableScanned = "1";

    const text = rowEl.textContent ?? "";
    const urlRe = /https?:\/\/[^\s)>\]]+/g;
    const pathRe = /(?:~|\.)?\/[^\s)>\]]+/g;

    const regions: { start: number; end: number; type: string; value: string }[] = [];

    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "url", value: m[0] });
    }
    while ((m = pathRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "path", value: m[0] });
    }

    // Wire hover and click on matching cells
    const cells = rowEl.querySelectorAll(".cell");
    for (const region of regions) {
      for (let c = region.start; c < region.end && c < cells.length; c++) {
        const cell = cells[c] as HTMLElement;

        cell.addEventListener("mouseenter", () => {
          for (let cc = region.start; cc < region.end && cc < cells.length; cc++) {
            (cells[cc] as HTMLElement).classList.add("clickable-hover");
          }
        });

        cell.addEventListener("mouseleave", () => {
          for (let cc = region.start; cc < region.end && cc < cells.length; cc++) {
            (cells[cc] as HTMLElement).classList.remove("clickable-hover");
          }
        });

        cell.addEventListener("click", () => {
          if (region.type === "url") {
            invoke("open_url", { url: region.value }).catch(console.error);
          } else {
            invoke("check_path_type", { path: region.value }).then((pathType: unknown) => {
              if (pathType === "file") {
                invoke("open_file", { path: region.value }).catch(console.error);
              } else if (pathType === "directory") {
                const cmd = `cd ${region.value}\r`;
                const bytes = Array.from(new TextEncoder().encode(cmd));
                invoke("write_to_pty", { data: bytes }).catch(console.error);
              }
            }).catch(() => {});
          }
        });
      }
    }
  }
}
```

- [ ] **Step 3: Wire clickable detection in main.ts**

In `src/main.ts`, add import:

```typescript
import { applyClickableRegions } from "./terminal/clickable";
```

In the terminal-output listener, add debounced clickable detection:

```typescript
let clickableTimer: ReturnType<typeof setTimeout> | null = null;

listen<GridSnapshot>("terminal-output", (event) => {
  domGrid.render(event.payload);
  mouse.updateMode(event.payload.mouse_mode);

  // Update window title if changed
  if (event.payload.title) {
    document.title = event.payload.title;
  }

  // Debounced clickable region detection
  if (clickableTimer) clearTimeout(clickableTimer);
  clickableTimer = setTimeout(() => {
    applyClickableRegions(domGrid.getScrollElement(), event.payload.mouse_mode).catch(() => {});
  }, 200);
}).catch((err) => {
  console.warn("terminal-output listener failed:", err);
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: clickable URLs and file paths — hover underline, click to open"
```

---

### Task 8: Configurable Cursor Styles

**Files:**
- Modify: `src/styles/wallace.css`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Replace cursor CSS with three style variants**

In `src/styles/wallace.css`, replace the existing `.cell--cursor` and `@keyframes cursor-blink` (around line 634):

```css
/* ── Cursor styles ───────────────────────────────────────────────────────── */

.cell--cursor-block {
  background: var(--koji-bright) !important;
  color: var(--koji-void) !important;
  animation: cursor-blink-block 1s step-end infinite;
}

.cell--cursor-beam {
  border-left: 3px solid var(--koji-bright);
  animation: cursor-blink-beam 1s step-end infinite;
}

.cell--cursor-underline {
  border-bottom: 2px solid var(--koji-bright);
  animation: cursor-blink-underline 1s step-end infinite;
}

@keyframes cursor-blink-block {
  0%, 100% { background: var(--koji-bright); color: var(--koji-void); }
  50% { background: transparent; color: inherit; }
}

@keyframes cursor-blink-beam {
  0%, 100% { border-left-color: var(--koji-bright); }
  50% { border-left-color: transparent; }
}

@keyframes cursor-blink-underline {
  0%, 100% { border-bottom-color: var(--koji-bright); }
  50% { border-bottom-color: transparent; }
}
```

- [ ] **Step 2: Update DOMGrid cursor to use configurable style**

In `src/terminal/dom-grid.ts`, add a field to DOMGrid:

```typescript
private cursorStyle: "block" | "beam" | "underline" = "block";
```

Add a public setter:

```typescript
setCursorStyle(style: "block" | "beam" | "underline"): void {
  this.cursorStyle = style;
  // Force cursor redraw
  if (this.lastSnapshot) {
    this.updateCursor(this.lastSnapshot.cursor);
  }
}
```

Update the `updateCursor` method to use the configured style:

```typescript
private updateCursor(cursor: CursorPos): void {
  const cursorClass = `cell--cursor-${this.cursorStyle}`;

  // Remove old cursor
  if (this.cursorRow >= 0 && this.cursorRow < this.viewportRows.length) {
    const oldRow = this.viewportRows[this.cursorRow].el;
    const oldCell = oldRow.children[this.cursorCol] as HTMLElement | undefined;
    if (oldCell) {
      oldCell.classList.remove("cell--cursor-block", "cell--cursor-beam", "cell--cursor-underline");
    }
  }

  // Add new cursor
  if (cursor.row >= 0 && cursor.row < this.viewportRows.length) {
    const newRow = this.viewportRows[cursor.row].el;
    const newCell = newRow.children[cursor.col] as HTMLElement | undefined;
    if (newCell) newCell.classList.add(cursorClass);
  }

  this.cursorRow = cursor.row;
  this.cursorCol = cursor.col;
}
```

- [ ] **Step 3: Add /cursor command to router and handler**

In `src/commands/router.ts`, add to the import:

```typescript
import { handleHelp, handleTheme, handleLlm, handleVersion, handleAgent, handleExit, handleFont, handleCursor } from "./handlers";
```

Add to the switch:

```typescript
case "cursor":
  return handleCursor(rest.join(" "));
```

In `src/commands/handlers.ts`, add:

```typescript
const CURSOR_STYLES = [
  { name: "block", description: "Solid rectangle — classic terminal" },
  { name: "beam", description: "Thin vertical line — modern/IDE feel" },
  { name: "underline", description: "Horizontal line under character — minimal" },
];

export async function handleCursor(args: string): Promise<DispatchResult> {
  if (!args) {
    const currentStyle = await invoke<string>("load_config", { key: "cursor_style" }).catch(() => "block") || "block";
    const result: MenuResult = {
      type: "menu",
      items: CURSOR_STYLES.map((s) => ({
        label: s.name,
        value: s.name,
        description: s.description,
        active: s.name === currentStyle,
      })),
      onSelect: async (value: string) => {
        await invoke("save_config", { key: "cursor_style", value });
        // Dynamic import to avoid circular dep
        const { domGrid } = await import("../main");
        domGrid.setCursorStyle(value as "block" | "beam" | "underline");
      },
    };
    return result;
  }

  const style = args.toLowerCase();
  if (["block", "beam", "underline"].includes(style)) {
    await invoke("save_config", { key: "cursor_style", value: style });
    const { domGrid } = await import("../main");
    domGrid.setCursorStyle(style as "block" | "beam" | "underline");
    return { output: `Cursor: ${style}`, isError: false };
  }

  return { output: "Usage: /cursor block|beam|underline", isError: true };
}
```

- [ ] **Step 4: Load saved cursor style on startup in main.ts**

In `src/main.ts`, after DOMGrid init:

```typescript
// Load saved cursor style
invoke("load_config", { key: "cursor_style" }).then((val: unknown) => {
  if (val === "beam" || val === "underline") {
    domGrid.setCursorStyle(val as "beam" | "underline");
  }
  // Default is "block" — no action needed
}).catch(() => {});
```

- [ ] **Step 5: Add /cursor to help menu**

In `src/commands/handlers.ts`, in `handleHelp()`, add an entry:

```typescript
{ label: "/cursor", value: "cursor", description: "Change cursor style" },
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: configurable cursor styles — block (default), beam, underline"
```

---

## Phase 5: Integration & Build (Task 9)

### Task 9: Final Integration, Version Bump, and Production Build

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/commands/handlers.ts`

- [ ] **Step 1: Version bump**

In `src-tauri/Cargo.toml`:
```toml
version = "0.5.0"
```

In `src-tauri/tauri.conf.json`:
```json
"version": "0.5.0"
```

In `src/commands/handlers.ts`, update `handleVersion()`:
```typescript
return { output: "Kōji Baseline v0.5.0", isError: false };
```

- [ ] **Step 2: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 4: Full production build**

```bash
cd /Users/hanamori/koji-baseline && npm run tauri build
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Kōji Baseline v0.5.0 — terminal completeness: alt screen, meta key, mouse, search, ANSI, OSC, bell, URLs, cursor styles"
```
