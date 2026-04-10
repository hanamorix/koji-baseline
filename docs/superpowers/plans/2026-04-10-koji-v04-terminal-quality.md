# Kōji Baseline v0.4 — Terminal Quality Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Canvas 2D terminal renderer with a DOM-based grid to unlock native text selection, ligatures, emoji/CJK support, smooth scrollback, and full clipboard ergonomics. Remove the waveform animation. Add a curated font system. Hit strict performance targets (< 4ms frame, < 1% idle CPU, 0 RAF loops at idle).

**Architecture:** The DOM grid renders terminal cells as `<span>` elements inside row `<div>`s within a scrollable container. A shadow grid tracks previous state for row-level diffing (only changed rows touch DOM). Cursor blink is pure CSS. Scrollback lines arrive via a new `scrollback-append` Tauri event and are prepended to the scroll container. Font selection, size, and ligature toggle persist in config. Selection and clipboard use native browser APIs with smart Cmd+C (copy if selected, SIGINT if not).

**Tech Stack:** TypeScript (DOM grid, selection, font system), Rust (scrollback event emission, config), CSS (cursor animation, scrollbar, selection highlight, font-face, ligatures), WOFF2 fonts (Fira Code, Cascadia Code, Iosevka bundled alongside existing JetBrains Mono).

**Spec:** `docs/superpowers/specs/2026-04-10-koji-v04-terminal-quality-design.md`

**Project location:** `/Users/hanamori/koji-baseline/`

---

## Phase 1: Strip & Scaffold (Tasks 1-2)

### Task 1: Remove Waveform Animation

Remove the waveform from all layers — HTML, CSS, TypeScript, and event wiring.

**Files:**
- Remove: `src/animation/waveform.ts`
- Modify: `index.html`
- Modify: `src/styles/wallace.css`
- Modify: `src/main.ts`

- [ ] **Step 1: Remove waveform divs from index.html**

In `index.html`, remove the two waveform divs (lines 28 and 36):

```html
<!-- DELETE this line (line 28): -->
    <div class="waveform" id="waveform-top"></div>

<!-- DELETE this line (line 36): -->
    <div class="waveform" id="waveform-bottom"></div>
```

The resulting structure between `.dashboard-top` and `.dashboard-bottom` should be:

```html
    <!-- ── Terminal canvas ────────────────────────────────────── -->
    <div class="terminal-viewport" id="terminal-container">
      <div class="terminal-overlay" id="terminal-overlay"></div>
    </div>
```

- [ ] **Step 2: Remove waveform CSS from wallace.css**

Remove the `.waveform` rule block (lines 160-176 of `src/styles/wallace.css`):

```css
/* DELETE this entire block: */
.waveform {
  height: 12px;
  overflow: hidden;
  white-space: nowrap;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  letter-spacing: -0.5px;
  color: var(--koji-faded);
}

#waveform-top {
  border-bottom: 1px solid var(--koji-deep);
}

#waveform-bottom {
  border-top: 1px solid var(--koji-deep);
}
```

- [ ] **Step 3: Remove waveform import and wiring from main.ts**

In `src/main.ts`, remove the WaveformAnimator import (around line 10):

```typescript
// DELETE this import:
import { WaveformAnimator } from "./animation/waveform";
```

Remove the waveform initialization block (around lines 34-41 of the boot sequence section):

```typescript
// DELETE this block:
const waveform = new WaveformAnimator("waveform-top", "waveform-bottom");
waveform.start();
```

Remove the CPU percent listener that feeds the waveform. In the `system-stats` event listener, find and remove the `waveform.setCpuPercent(...)` call. Keep the rest of the listener (CPU/MEM display updates).

- [ ] **Step 4: Delete waveform.ts**

```bash
rm src/animation/waveform.ts
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

Expected: no errors. If there are unused import warnings for waveform references, clean them up.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: remove waveform animation — terminal viewport expands to fill space"
```

---

### Task 2: Remove Canvas Scan Line from Idle Animator

Keep kanji cycling, remove the Canvas-based scan line, switch from RAF to setInterval.

**Files:**
- Modify: `src/ascii/idle.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Rewrite idle.ts to remove scan line and RAF loop**

Replace the entire contents of `src/ascii/idle.ts` with:

```typescript
// idle.ts — Kanji cycling idle animation (no scan line, no RAF)

const IDLE_THRESHOLD_MS = 30_000;
const KANJI_CYCLE = "光路影幻夢霧雨風雷炎氷星月闇";
const KANJI_INTERVAL_MS = 800;

type StateCallback = (idle: boolean, kanji?: string) => void;

export class IdleAnimator {
  private lastInput = Date.now();
  private isIdle = false;
  private kanjiIndex = 0;
  private kanjiInterval: ReturnType<typeof setInterval> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stateCallbacks: StateCallback[] = [];

  constructor() {
    const reset = () => this.resetIdle();
    document.addEventListener("keydown", reset);
    document.addEventListener("mousemove", reset);
  }

  onStateChange(cb: StateCallback): void {
    this.stateCallbacks.push(cb);
  }

  getCurrentKanji(): string {
    return KANJI_CYCLE[this.kanjiIndex % KANJI_CYCLE.length];
  }

  private resetIdle(): void {
    this.lastInput = Date.now();
    if (this.isIdle) {
      this.stopIdle();
      this.isIdle = false;
      this.notify(false);
    }
  }

  private notify(idle: boolean): void {
    const kanji = idle ? this.getCurrentKanji() : undefined;
    this.stateCallbacks.forEach((cb) => cb(idle, kanji));
  }

  private startIdle(): void {
    this.isIdle = true;
    this.kanjiIndex = 0;
    this.notify(true);
    this.kanjiInterval = setInterval(() => {
      this.kanjiIndex = (this.kanjiIndex + 1) % KANJI_CYCLE.length;
      this.notify(true);
    }, KANJI_INTERVAL_MS);
  }

  private stopIdle(): void {
    if (this.kanjiInterval) {
      clearInterval(this.kanjiInterval);
      this.kanjiInterval = null;
    }
  }

  /** Start the idle checker. Uses setInterval instead of RAF — no animation frames consumed. */
  start(): void {
    this.checkInterval = setInterval(() => {
      if (!this.isIdle && Date.now() - this.lastInput >= IDLE_THRESHOLD_MS) {
        this.startIdle();
      }
    }, 1000);
  }

  stop(): void {
    this.stopIdle();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
```

- [ ] **Step 2: Update main.ts idle animator wiring**

In `src/main.ts`, find the IdleAnimator initialization section (around lines 65-89). The current code passes a canvas to `setCanvas()` and wires canvas-dependent callbacks. Replace with:

```typescript
// ── Idle animator (kanji cycling only, no canvas) ──────────────────────────
const idle = new IdleAnimator();
idle.onStateChange((isIdle, kanji) => {
  const el = document.getElementById("idle-icon");
  if (el) {
    el.textContent = isIdle && kanji ? kanji : "";
  }
});
idle.start();
```

Remove any `idle.setCanvas(...)` call — the method no longer exists.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: idle animator — remove scan line, keep kanji cycling, switch RAF to setInterval"
```

---

## Phase 2: DOM Grid Renderer (Tasks 3-5)

### Task 3: Create DOM Grid Renderer

Build the new DOM-based terminal grid with row-level diffing and CSS cursor blink.

**Files:**
- Create: `src/terminal/dom-grid.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add DOM grid CSS to wallace.css**

Append to `src/styles/wallace.css`:

```css
/* ── DOM Terminal Grid ──────────────────────────────────────────────────────── */

.terminal-grid {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: hidden;
}

.grid-scroll {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  scroll-behavior: smooth;
}

/* Themed scrollbar — fade on idle via JS class toggle */
.grid-scroll::-webkit-scrollbar {
  width: 6px;
}

.grid-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.grid-scroll::-webkit-scrollbar-thumb {
  background: var(--koji-faded);
  border-radius: 3px;
  transition: opacity 0.3s ease;
}

.grid-scroll.scrollbar-hidden::-webkit-scrollbar-thumb {
  background: transparent;
}

.grid-row {
  white-space: pre;
  line-height: 1.3;
  height: 1.3em;
}

.cell {
  display: inline-block;
  width: 1ch;
  text-align: center;
}

.cell.wide {
  width: 2ch;
}

.cell--cursor {
  animation: cursor-blink 1s step-end infinite;
}

@keyframes cursor-blink {
  0%, 100% { border-left: 2px solid var(--koji-bright); }
  50% { border-left: 2px solid transparent; }
}

/* Selection highlight */
.terminal-grid ::selection {
  background: rgba(255, 140, 0, 0.25);
}

.terminal-grid ::-moz-selection {
  background: rgba(255, 140, 0, 0.25);
}
```

- [ ] **Step 2: Create dom-grid.ts**

Create `src/terminal/dom-grid.ts`:

```typescript
// dom-grid.ts — DOM-based terminal grid renderer with row-level diffing

export interface RenderCell {
  character: string;
  fg: [number, number, number];
  bg: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
  wide?: boolean;
  spacer?: boolean;
}

export interface CursorPos {
  row: number;
  col: number;
}

export interface GridSnapshot {
  cells: RenderCell[][];
  cursor: CursorPos;
  rows: number;
  cols: number;
}

interface RowState {
  el: HTMLDivElement;
  hash: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cellHash(cell: RenderCell): string {
  return `${cell.character}|${cell.fg[0]},${cell.fg[1]},${cell.fg[2]}|${cell.bg[0]},${cell.bg[1]},${cell.bg[2]}|${cell.bold ? 1 : 0}${cell.italic ? 1 : 0}${cell.underline ? 1 : 0}${cell.dim ? 1 : 0}${cell.wide ? 1 : 0}`;
}

function rowHash(cells: RenderCell[]): string {
  let h = "";
  for (const cell of cells) {
    if (cell.spacer) continue;
    h += cellHash(cell);
  }
  return h;
}

function rgbStyle(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

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

    const cls = cell.wide ? "cell wide" : "cell";
    const decoration = cell.underline ? ` style="${style}text-decoration:underline;"` : ` style="${style}"`;

    html += `<span class="${cls}"${decoration}>${char}</span>`;
  }
  return html;
}

function escapeHTML(s: string): string {
  switch (s) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return s;
  }
}

// ── DOMGrid class ───────────────────────────────────────────────────────────

export class DOMGrid {
  private container: HTMLElement;
  private gridEl: HTMLDivElement;
  private scrollEl: HTMLDivElement;
  private viewportRows: RowState[] = [];
  private cursorRow = -1;
  private cursorCol = -1;
  private rows = 0;
  private cols = 0;
  private lastSnapshot: GridSnapshot | null = null;
  private pendingSnapshot: GridSnapshot | null = null;
  private rafPending = false;
  private scrollbarTimer: ReturnType<typeof setTimeout> | null = null;
  private autoScroll = true;
  private fontFamily = "'JetBrains Mono', 'Apple Color Emoji', 'Hiragino Sans', 'Noto Sans CJK SC', monospace";
  private fontSize = 14;
  private ligatures = true;

  constructor(container: HTMLElement) {
    this.container = container;

    // Build DOM structure
    this.gridEl = document.createElement("div");
    this.gridEl.className = "terminal-grid";

    this.scrollEl = document.createElement("div");
    this.scrollEl.className = "grid-scroll scrollbar-hidden";

    this.gridEl.appendChild(this.scrollEl);
    this.container.appendChild(this.gridEl);

    this.applyFontStyles();
    this.setupScrollTracking();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;

    // Ensure we have exactly `rows` row elements for the viewport
    while (this.viewportRows.length < rows) {
      const el = document.createElement("div");
      el.className = "grid-row";
      this.scrollEl.appendChild(el);
      this.viewportRows.push({ el, hash: "" });
    }
    while (this.viewportRows.length > rows) {
      const removed = this.viewportRows.pop()!;
      removed.el.remove();
    }

    if (this.lastSnapshot) {
      this.renderImmediate(this.lastSnapshot);
    }
  }

  /** Queue a snapshot for rendering. Only the latest snapshot per frame is rendered. */
  render(snapshot: GridSnapshot): void {
    this.pendingSnapshot = snapshot;
    if (!this.rafPending) {
      this.rafPending = true;
      requestAnimationFrame(() => {
        this.rafPending = false;
        if (this.pendingSnapshot) {
          this.renderImmediate(this.pendingSnapshot);
          this.pendingSnapshot = null;
        }
      });
    }
  }

  getLastSnapshot(): GridSnapshot | null {
    return this.lastSnapshot;
  }

  getGridElement(): HTMLDivElement {
    return this.gridEl;
  }

  getScrollElement(): HTMLDivElement {
    return this.scrollEl;
  }

  setFont(family: string, size: number, ligatures: boolean): void {
    this.fontFamily = `'${family}', 'Apple Color Emoji', 'Hiragino Sans', 'Noto Sans CJK SC', monospace`;
    this.fontSize = size;
    this.ligatures = ligatures;
    this.applyFontStyles();
    // Force full re-render
    this.viewportRows.forEach((r) => (r.hash = ""));
    if (this.lastSnapshot) this.renderImmediate(this.lastSnapshot);
  }

  setFontSize(size: number): void {
    this.fontSize = Math.max(10, Math.min(24, size));
    this.applyFontStyles();
    this.viewportRows.forEach((r) => (r.hash = ""));
    if (this.lastSnapshot) this.renderImmediate(this.lastSnapshot);
  }

  getFontSize(): number {
    return this.fontSize;
  }

  /** Calculate grid dimensions from container size and current font metrics. */
  measureGrid(): { rows: number; cols: number } {
    // Create a measuring element to get exact character dimensions
    const measure = document.createElement("span");
    measure.className = "cell";
    measure.style.fontFamily = this.fontFamily;
    measure.style.fontSize = `${this.fontSize}px`;
    measure.style.position = "absolute";
    measure.style.visibility = "hidden";
    measure.textContent = "W";
    this.container.appendChild(measure);

    const charWidth = measure.getBoundingClientRect().width;
    const lineHeight = this.fontSize * 1.3;
    measure.remove();

    const containerRect = this.container.getBoundingClientRect();
    const cols = Math.floor(containerRect.width / charWidth);
    const rows = Math.floor(containerRect.height / lineHeight);

    return { rows: Math.max(1, rows), cols: Math.max(1, cols) };
  }

  destroy(): void {
    this.gridEl.remove();
    if (this.scrollbarTimer) clearTimeout(this.scrollbarTimer);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private applyFontStyles(): void {
    this.scrollEl.style.fontFamily = this.fontFamily;
    this.scrollEl.style.fontSize = `${this.fontSize}px`;
    this.scrollEl.style.fontVariantLigatures = this.ligatures ? "normal" : "none";
  }

  private setupScrollTracking(): void {
    this.scrollEl.addEventListener("scroll", () => {
      // Show scrollbar
      this.scrollEl.classList.remove("scrollbar-hidden");
      if (this.scrollbarTimer) clearTimeout(this.scrollbarTimer);
      this.scrollbarTimer = setTimeout(() => {
        this.scrollEl.classList.add("scrollbar-hidden");
      }, 1500);

      // Auto-scroll tracking: if user scrolled to bottom (within 5px), re-enable
      const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
      this.autoScroll = scrollHeight - scrollTop - clientHeight < 5;
    });
  }

  private renderImmediate(snapshot: GridSnapshot): void {
    this.lastSnapshot = snapshot;

    // Ensure correct row count
    if (this.viewportRows.length !== snapshot.rows) {
      this.resize(snapshot.rows, snapshot.cols);
    }

    // Row-level diffing
    for (let r = 0; r < snapshot.rows; r++) {
      const cells = snapshot.cells[r];
      if (!cells) continue;

      const newHash = rowHash(cells);
      const rowState = this.viewportRows[r];

      if (newHash !== rowState.hash) {
        rowState.el.innerHTML = buildRowHTML(cells);
        rowState.hash = newHash;
      }
    }

    // Cell-level cursor update
    this.updateCursor(snapshot.cursor);

    // Auto-scroll to bottom if enabled
    if (this.autoScroll) {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
  }

  private updateCursor(cursor: CursorPos): void {
    // Remove old cursor
    if (this.cursorRow >= 0 && this.cursorRow < this.viewportRows.length) {
      const oldRow = this.viewportRows[this.cursorRow].el;
      const oldCell = oldRow.children[this.cursorCol] as HTMLElement | undefined;
      if (oldCell) oldCell.classList.remove("cell--cursor");
    }

    // Add new cursor
    if (cursor.row >= 0 && cursor.row < this.viewportRows.length) {
      const newRow = this.viewportRows[cursor.row].el;
      const newCell = newRow.children[cursor.col] as HTMLElement | undefined;
      if (newCell) newCell.classList.add("cell--cursor");
    }

    this.cursorRow = cursor.row;
    this.cursorCol = cursor.col;
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: DOM grid renderer with row-level diffing, CSS cursor blink, frame batching"
```

---

### Task 4: Wire DOM Grid into Main and Replace Canvas

Swap the Canvas renderer for the DOM grid in main.ts. Update index.html. Remove old grid.ts and scrollback.ts.

**Files:**
- Modify: `src/main.ts`
- Modify: `index.html`
- Remove: `src/terminal/grid.ts`
- Remove: `src/terminal/scrollback.ts`
- Modify: `src/terminal/clickable.ts`

- [ ] **Step 1: Update index.html — replace Canvas viewport with DOM grid container**

In `index.html`, the `.terminal-viewport` div (around line 31) currently contains only the overlay div. Keep it — the DOMGrid constructor will append its own elements inside it. No HTML changes needed here beyond confirming the waveform divs are already gone from Task 1.

- [ ] **Step 2: Rewrite main.ts grid initialization and event wiring**

In `src/main.ts`, replace the grid-related imports and initialization:

**Replace imports:**

```typescript
// DELETE these imports:
import { TerminalGrid, GridSnapshot } from "./terminal/grid";
import { TransitionEffects } from "./animation/effects";

// ADD this import:
import { DOMGrid, GridSnapshot } from "./terminal/dom-grid";
```

**Replace grid initialization** (around lines 61-63 and the effects block around lines 83-89):

```typescript
// DELETE:
export const grid = new TerminalGrid("terminal-container");

// DELETE the TransitionEffects block:
const effects = new TransitionEffects(grid.getCanvas());

// ADD:
const container = document.getElementById("terminal-container")!;
export const domGrid = new DOMGrid(container);
```

**Replace terminal-output listener** (around lines 139-152):

```typescript
// ── Terminal I/O ──────────────────────────────────────────────────────────
let clickableDebounce: ReturnType<typeof setTimeout> | null = null;

listen<GridSnapshot>("terminal-output", (event) => {
  domGrid.render(event.payload);

  // Debounced clickable region detection
  if (clickableDebounce) clearTimeout(clickableDebounce);
  clickableDebounce = setTimeout(async () => {
    const snap = domGrid.getLastSnapshot();
    if (!snap) return;
    // clickable detection will be adapted in a later step
  }, 200);
}).catch((err) => {
  console.warn("terminal-output listener failed:", err);
});
```

**Replace initial terminal size calculation** (around lines 154-159):

```typescript
// ── Initial terminal size ─────────────────────────────────────────────────
const { rows: initRows, cols: initCols } = domGrid.measureGrid();
domGrid.resize(initRows, initCols);
invoke("init_terminal", { rows: initRows, cols: initCols });
```

**Replace resize observer** (around lines 161-178):

```typescript
// ── Resize observer ───────────────────────────────────────────────────────
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

new ResizeObserver(() => {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => {
    const { rows, cols } = domGrid.measureGrid();
    domGrid.resize(rows, cols);
    invoke("resize_terminal", { rows, cols });
  }, 50);
}).observe(container);
```

**Replace theme-applied listener** (around lines 131-137):

```typescript
listen("theme-applied", () => {
  // DOM grid inherits CSS custom properties automatically — force re-render for inline styles
  const snap = domGrid.getLastSnapshot();
  if (snap) domGrid.render(snap);
}).catch((err) => {
  console.warn("theme-applied listener failed:", err);
});
```

**Remove all `effects.commandSubmit()` calls** (in the keyboard handler around the Enter key handling). We'll add CSS-based effects in a later task.

**Remove mouse interaction block** that depends on `grid.getCellFromClick()` and `grid.setClickableRegions()` (around lines 180-215). Clickable regions will be revisited in a future version — for now, URLs and file paths in terminal output won't be clickable. This is acceptable because the DOM grid is the critical path.

**Update the exported grid reference** — any other files that import `grid` from main.ts need to import `domGrid` instead. Check:
- `src/agent/pane.ts` imports `grid` — update to `domGrid`

- [ ] **Step 3: Update clickable.ts — make GridSnapshot import point to dom-grid**

In `src/terminal/clickable.ts`, update the import (if it imports GridSnapshot from grid.ts):

```typescript
// If present, change:
import { GridSnapshot } from "./grid";
// To:
import { GridSnapshot } from "./dom-grid";
```

If clickable.ts doesn't import GridSnapshot directly (it takes a grid parameter), no change needed.

- [ ] **Step 4: Delete old Canvas renderer files**

```bash
rm src/terminal/grid.ts src/terminal/scrollback.ts
```

- [ ] **Step 5: Fix any remaining import errors**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

Fix any remaining references to the old `TerminalGrid`, `grid` export, `effects`, or `scrollback` modules. Common places:
- `src/agent/pane.ts` — if it imports `grid` from `../main`, change to `domGrid`
- Any file importing from `./terminal/grid` — switch to `./terminal/dom-grid`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: wire DOM grid into main — replace Canvas renderer, remove old grid.ts and scrollback.ts"
```

---

### Task 5: Rewrite Transition Effects as CSS Animations

Replace Canvas-based command effects with CSS class toggles.

**Files:**
- Modify: `src/animation/effects.ts`
- Modify: `src/styles/wallace.css`
- Modify: `src/main.ts`

- [ ] **Step 1: Add CSS effect animations to wallace.css**

Append to `src/styles/wallace.css`:

```css
/* ── Command transition effects (CSS-only) ──────────────────────────────── */

@keyframes command-flash {
  0% { background: rgba(255, 106, 0, 0.06); }
  100% { background: transparent; }
}

@keyframes error-flicker {
  0%, 40%, 80% { background: rgba(255, 69, 0, 0.08); }
  20%, 60%, 100% { background: transparent; }
}

@keyframes completion-pulse {
  0% { background: rgba(204, 122, 0, 0.08); }
  100% { background: transparent; }
}

.terminal-grid.effect-flash {
  animation: command-flash 0.2s ease-out;
}

.grid-row.effect-error {
  animation: error-flicker 0.32s ease-out;
}

.grid-row.effect-complete {
  animation: completion-pulse 0.4s ease-out;
}
```

- [ ] **Step 2: Rewrite effects.ts as CSS class toggler**

Replace the entire contents of `src/animation/effects.ts`:

```typescript
// effects.ts — CSS-based command transition effects (no Canvas, no RAF)

export class TransitionEffects {
  private gridEl: HTMLElement;

  constructor(gridEl: HTMLElement) {
    this.gridEl = gridEl;
  }

  /** Brief amber flash across the entire grid on command submit. */
  commandSubmit(): void {
    this.gridEl.classList.remove("effect-flash");
    // Force reflow to restart animation
    void this.gridEl.offsetWidth;
    this.gridEl.classList.add("effect-flash");
    this.gridEl.addEventListener("animationend", () => {
      this.gridEl.classList.remove("effect-flash");
    }, { once: true });
  }

  /** Amber pulse on rows that received command output. */
  commandComplete(startRow: number, endRow: number): void {
    this.applyRowEffect("effect-complete", startRow, endRow);
  }

  /** Red flicker on error rows. */
  errorFlicker(startRow: number, endRow: number): void {
    this.applyRowEffect("effect-error", startRow, endRow);
  }

  private applyRowEffect(cls: string, startRow: number, endRow: number): void {
    const rows = this.gridEl.querySelectorAll(".grid-row");
    for (let i = startRow; i <= endRow && i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      row.classList.remove(cls);
      void row.offsetWidth;
      row.classList.add(cls);
      row.addEventListener("animationend", () => {
        row.classList.remove(cls);
      }, { once: true });
    }
  }
}
```

- [ ] **Step 3: Wire effects to DOM grid in main.ts**

In `src/main.ts`, add the effects initialization after the DOMGrid creation:

```typescript
import { TransitionEffects } from "./animation/effects";

// After DOMGrid init:
const effects = new TransitionEffects(domGrid.getGridElement());
```

Re-add `effects.commandSubmit()` in the keyboard handler where Enter is pressed to submit a command (around the `currentInput` handling section).

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: transition effects — Canvas RAF loops replaced with CSS animations"
```

---

## Phase 3: Scrollback (Task 6)

### Task 6: Scrollback Buffer with Rust Event Emission

Add scrollback support: Rust emits lines as they leave the viewport, frontend manages a capped DOM buffer with smooth scrolling.

**Files:**
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/terminal/dom-grid.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add scrollback tracking to TerminalEngine in terminal.rs**

In `src-tauri/src/terminal.rs`, add a field to track the previous display offset so we can detect when new lines scroll off:

Add to the `TerminalEngine` struct (around line 184):

```rust
pub struct TerminalEngine {
    term: Term<VoidListener>,
    parser: Processor,
    rows: usize,
    cols: usize,
    pub color_overrides: HashMap<String, [u8; 3]>,
    prev_history_len: usize,
}
```

Update `new()` (around line 191) to initialize it:

```rust
pub fn new(rows: usize, cols: usize) -> Self {
    // ... existing code ...
    Self {
        term,
        parser,
        rows,
        cols,
        color_overrides: HashMap::new(),
        prev_history_len: 0,
    }
}
```

Add a method to extract new scrollback lines:

```rust
/// Return any new scrollback lines since the last call.
pub fn drain_scrollback(&mut self) -> Vec<Vec<RenderCell>> {
    let content = self.term.grid();
    let total_lines = content.total_lines();
    let display_lines = self.rows;
    let history_len = if total_lines > display_lines {
        total_lines - display_lines
    } else {
        0
    };

    if history_len <= self.prev_history_len {
        self.prev_history_len = history_len;
        return Vec::new();
    }

    let new_count = history_len - self.prev_history_len;
    let mut result = Vec::with_capacity(new_count);

    // History lines are at negative offsets: Line(-(history_len)), ..., Line(-1)
    // New lines are the most recent ones pushed into history
    for i in 0..new_count {
        let line_idx = self.prev_history_len + i;
        let offset = -((history_len - line_idx) as i32);
        let row = &content[alacritty_terminal::grid::Line(offset)];
        let mut cells = Vec::with_capacity(self.cols);
        for col in 0..self.cols {
            let cell = &row[alacritty_terminal::index::Column(col)];
            cells.push(cell_to_render(cell, &self.color_overrides));
        }
        result.push(cells);
    }

    self.prev_history_len = history_len;
    result
}
```

- [ ] **Step 2: Configure scrollback limit in alacritty_terminal**

In `src-tauri/src/terminal.rs`, in the `TerminalEngine::new()` method, find where `TermSize` is created and the `Term` is initialized. Add a scrollback limit to the terminal config. The alacritty_terminal `Config` struct accepts a `scrolling` field:

```rust
// In TerminalEngine::new(), update the Term creation:
let config = alacritty_terminal::term::Config {
    scrolling: alacritty_terminal::config::Scrolling {
        history: 10_000 as u32,
    },
    ..Default::default()
};
let term = Term::new(config, &size, VoidListener);
```

Note: Check the exact API of your pinned `alacritty_terminal = "=0.25.1"`. If the config API differs, adapt accordingly. The goal is to set `scrolling.history` to 10000.

- [ ] **Step 3: Emit scrollback-append event in the I/O thread**

In `src-tauri/src/lib.rs`, in the `init_terminal` function's I/O thread (around line 75-85), after `eng.process_bytes(&buf[..n])` and before `Some(eng.snapshot())`, add:

```rust
// Drain any new scrollback lines and emit them
let scrollback_lines = eng.drain_scrollback();
if !scrollback_lines.is_empty() {
    let _ = app.emit("scrollback-append", &scrollback_lines);
}
```

The `scrollback-append` event payload is `Vec<Vec<RenderCell>>` — a list of rows, each being a list of cells, same format as `GridSnapshot.cells` rows.

- [ ] **Step 4: Add scrollback handling to dom-grid.ts**

In `src/terminal/dom-grid.ts`, add a scrollback row list and methods:

Add fields to the `DOMGrid` class:

```typescript
private scrollbackRows: HTMLDivElement[] = [];
private maxScrollback = 10000;
```

Add a public method:

```typescript
/** Append scrollback rows above the viewport. Called when lines scroll off the top. */
appendScrollback(rows: RenderCell[][]): void {
  for (const cells of rows) {
    const el = document.createElement("div");
    el.className = "grid-row";
    el.innerHTML = buildRowHTML(cells);

    // Insert before the first viewport row
    if (this.viewportRows.length > 0) {
      this.scrollEl.insertBefore(el, this.viewportRows[0].el);
    } else {
      this.scrollEl.appendChild(el);
    }

    this.scrollbackRows.push(el);
  }

  // Trim oldest scrollback if over limit
  while (this.scrollbackRows.length > this.maxScrollback) {
    const oldest = this.scrollbackRows.shift()!;
    oldest.remove();
  }
}

setMaxScrollback(lines: number): void {
  this.maxScrollback = lines;
}
```

- [ ] **Step 5: Wire scrollback-append listener in main.ts**

In `src/main.ts`, add after the `terminal-output` listener:

```typescript
import type { RenderCell } from "./terminal/dom-grid";

listen<RenderCell[][]>("scrollback-append", (event) => {
  domGrid.appendScrollback(event.payload);
}).catch((err) => {
  console.warn("scrollback-append listener failed:", err);
});
```

- [ ] **Step 6: Add scroll keyboard shortcuts in main.ts**

In the keyboard handler in `src/main.ts`, add scroll shortcuts before the ANSI conversion:

```typescript
// Scroll shortcuts
if (event.shiftKey && key === "PageUp") {
  event.preventDefault();
  const scrollEl = domGrid.getScrollElement();
  scrollEl.scrollBy({ top: -scrollEl.clientHeight, behavior: "smooth" });
  return;
}
if (event.shiftKey && key === "PageDown") {
  event.preventDefault();
  const scrollEl = domGrid.getScrollElement();
  scrollEl.scrollBy({ top: scrollEl.clientHeight, behavior: "smooth" });
  return;
}
if (event.shiftKey && key === "Home") {
  event.preventDefault();
  domGrid.getScrollElement().scrollTo({ top: 0, behavior: "smooth" });
  return;
}
if (event.shiftKey && key === "End") {
  event.preventDefault();
  const scrollEl = domGrid.getScrollElement();
  scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
  return;
}
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
git add -A && git commit -m "feat: scrollback buffer — Rust emits scrollback-append events, 10k line DOM buffer, smooth scroll + keyboard shortcuts"
```

---

## Phase 4: Selection & Clipboard (Task 7)

### Task 7: Selection and Clipboard Ergonomics

Add smart Cmd+C, copy-on-select, middle-click paste, and bracketed paste.

**Files:**
- Create: `src/terminal/selection.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create selection.ts**

Create `src/terminal/selection.ts`:

```typescript
// selection.ts — Selection management, copy-on-select, smart Cmd+C, bracketed paste

import { invoke } from "@tauri-apps/api/core";

const BRACKET_OPEN = "\x1b[200~";
const BRACKET_CLOSE = "\x1b[201~";

export class SelectionManager {
  private gridEl: HTMLElement;
  private copyOnSelect: boolean;

  constructor(gridEl: HTMLElement, copyOnSelect = true) {
    this.gridEl = gridEl;
    this.copyOnSelect = copyOnSelect;
    this.setupCopyOnSelect();
    this.setupMiddleClick();
  }

  setCopyOnSelect(enabled: boolean): void {
    this.copyOnSelect = enabled;
  }

  /** Get currently selected text within the grid, or empty string if none. */
  getSelectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return "";

    // Only return text if selection is within our grid
    const range = sel.getRangeAt(0);
    if (!this.gridEl.contains(range.commonAncestorContainer)) return "";

    return sel.toString();
  }

  /** Smart Cmd+C: copy selection if present, otherwise send SIGINT (^C) to PTY. */
  async handleCopy(): Promise<boolean> {
    const text = this.getSelectedText();
    if (text) {
      await navigator.clipboard.writeText(text);
      // Clear selection after copy
      window.getSelection()?.removeAllRanges();
      return true; // copied
    }
    return false; // no selection — caller should send ^C
  }

  /** Paste from clipboard with bracketed paste escapes. */
  async handlePaste(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (!text) return;

    const bracketed = BRACKET_OPEN + text + BRACKET_CLOSE;
    const encoder = new TextEncoder();
    const data = Array.from(encoder.encode(bracketed));
    await invoke("write_to_pty", { data });
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private setupCopyOnSelect(): void {
    this.gridEl.addEventListener("mouseup", async () => {
      if (!this.copyOnSelect) return;
      // Small delay to let browser finalize selection
      await new Promise((r) => setTimeout(r, 10));
      const text = this.getSelectedText();
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    });
  }

  private setupMiddleClick(): void {
    this.gridEl.addEventListener("mousedown", async (e) => {
      if (e.button === 1) { // middle click
        e.preventDefault();
        await this.handlePaste();
      }
    });
  }
}
```

- [ ] **Step 2: Wire selection into main.ts keyboard handler**

In `src/main.ts`, import and initialize:

```typescript
import { SelectionManager } from "./terminal/selection";

// After DOMGrid init:
const selection = new SelectionManager(domGrid.getGridElement());
```

Replace the existing Cmd+C and Cmd+V handlers in the keyboard event listener:

```typescript
// Smart Cmd+C: copy selection or send SIGINT
if (metaKey && key === "c") {
  event.preventDefault();
  const copied = await selection.handleCopy();
  if (!copied) {
    // No selection — send ^C (SIGINT)
    const data = [3]; // ETX = Ctrl+C
    await invoke("write_to_pty", { data });
  }
  return;
}

// Cmd+V: bracketed paste
if (metaKey && key === "v") {
  event.preventDefault();
  await selection.handlePaste();
  return;
}
```

Note: The keyboard handler needs to be `async` or use `.then()` for the await calls. If it's not already async, wrap the handler body or use promise chaining.

- [ ] **Step 3: Load copy_on_select preference from config**

After selection manager init in `src/main.ts`:

```typescript
// Load copy-on-select preference
invoke("load_config", { key: "copy_on_select" }).then((val: unknown) => {
  if (val === "false") selection.setCopyOnSelect(false);
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: selection and clipboard — smart Cmd+C, copy-on-select, middle-click paste, bracketed paste"
```

---

## Phase 5: Font System (Tasks 8-9)

### Task 8: Bundle Fonts and Add Font Loader

Bundle the three additional fonts and create the font management system.

**Files:**
- Create: `src/fonts/fonts.ts`
- Create: `src/fonts/woff2/` (font files)
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Download font files**

```bash
mkdir -p /Users/hanamori/koji-baseline/src/fonts/woff2
cd /Users/hanamori/koji-baseline/src/fonts/woff2

# Download Fira Code Regular
curl -L -o FiraCode-Regular.woff2 "https://github.com/tonsky/FiraCode/raw/master/distr/woff2/FiraCode-Regular.woff2"

# Download Cascadia Code Regular
curl -L -o CascadiaCode-Regular.woff2 "https://github.com/microsoft/cascadia-code/releases/download/v2404.23/CascadiaCode-2404.23.zip"
# Extract the WOFF2 from the zip — the exact path inside may vary:
unzip -o CascadiaCode-2404.23.zip "ttf/static/CascadiaCode-Regular.ttf" -d /tmp/cascadia 2>/dev/null || true
# If WOFF2 isn't directly available, we'll convert from TTF or find the right asset.
# Check the zip contents:
# unzip -l CascadiaCode-2404.23.zip | grep -i woff2

# Download Iosevka Regular (SS14 variant — clean, modern)
curl -L -o Iosevka-Regular.woff2 "https://github.com/be5invis/Iosevka/releases/download/v31.9.1/PkgWebFont-Iosevka-31.9.1.zip"
# Extract WOFF2 from zip
```

Note: Font downloads may need manual intervention depending on release packaging. The goal is to have these three WOFF2 files:
- `FiraCode-Regular.woff2`
- `CascadiaCode-Regular.woff2`
- `Iosevka-Regular.woff2`

JetBrains Mono is already available (bundled or system-installed).

- [ ] **Step 2: Add @font-face declarations to wallace.css**

Add at the top of `src/styles/wallace.css` (before the `:root` block):

```css
/* ── Bundled fonts ──────────────────────────────────────────────────────── */

@font-face {
  font-family: 'Fira Code';
  src: url('../fonts/woff2/FiraCode-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Cascadia Code';
  src: url('../fonts/woff2/CascadiaCode-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Iosevka';
  src: url('../fonts/woff2/Iosevka-Regular.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 3: Create fonts.ts**

Create `src/fonts/fonts.ts`:

```typescript
// fonts.ts — Font management: curated picker, size controls, ligature toggle

import { invoke } from "@tauri-apps/api/core";

export interface FontOption {
  name: string;
  family: string;
  description: string;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    name: "JetBrains Mono",
    family: "JetBrains Mono",
    description: "Designed for code — tall x-height, 138 ligatures",
  },
  {
    name: "Fira Code",
    family: "Fira Code",
    description: "The OG ligature font — warm, rounded character",
  },
  {
    name: "Cascadia Code",
    family: "Cascadia Code",
    description: "Microsoft's terminal font — clean, modern, condensed",
  },
  {
    name: "Iosevka",
    family: "Iosevka",
    description: "Narrow and elegant — sci-fi aesthetic, fits more columns",
  },
];

export const DEFAULT_FONT = "JetBrains Mono";
export const DEFAULT_SIZE = 14;
export const MIN_SIZE = 10;
export const MAX_SIZE = 24;

export class FontManager {
  private currentFont: string = DEFAULT_FONT;
  private currentSize: number = DEFAULT_SIZE;
  private ligatures: boolean = true;
  private onChange: ((font: string, size: number, ligatures: boolean) => void) | null = null;

  setChangeCallback(cb: (font: string, size: number, ligatures: boolean) => void): void {
    this.onChange = cb;
  }

  getCurrent(): string {
    return this.currentFont;
  }

  getSize(): number {
    return this.currentSize;
  }

  getLigatures(): boolean {
    return this.ligatures;
  }

  async apply(fontName: string): Promise<boolean> {
    const option = FONT_OPTIONS.find((f) => f.name === fontName);
    if (!option) return false;

    this.currentFont = option.family;
    this.notify();
    await invoke("save_config", { key: "font", value: fontName });
    return true;
  }

  async setSize(size: number): Promise<void> {
    this.currentSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
    this.notify();
    await invoke("save_config", { key: "font_size", value: String(this.currentSize) });
  }

  async incrementSize(delta: number): Promise<void> {
    await this.setSize(this.currentSize + delta);
  }

  async setLigatures(enabled: boolean): Promise<void> {
    this.ligatures = enabled;
    this.notify();
    await invoke("save_config", { key: "ligatures", value: String(enabled) });
  }

  async loadSaved(): Promise<void> {
    try {
      const font = await invoke("load_config", { key: "font" }) as string;
      if (font) {
        const option = FONT_OPTIONS.find((f) => f.name === font);
        if (option) this.currentFont = option.family;
      }

      const size = await invoke("load_config", { key: "font_size" }) as string;
      if (size) {
        const parsed = parseInt(size, 10);
        if (!isNaN(parsed)) this.currentSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, parsed));
      }

      const lig = await invoke("load_config", { key: "ligatures" }) as string;
      if (lig === "false") this.ligatures = false;

      this.notify();
    } catch {
      // Config not found — use defaults
    }
  }

  private notify(): void {
    if (this.onChange) {
      this.onChange(this.currentFont, this.currentSize, this.ligatures);
    }
  }
}

export const fontManager = new FontManager();
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: font system — bundled Fira Code, Cascadia Code, Iosevka + font manager with size and ligature controls"
```

---

### Task 9: Wire Font System — Commands, Shortcuts, Grid Integration

Connect the font manager to the DOM grid, add `/font` command, and Cmd+/- shortcuts.

**Files:**
- Modify: `src/main.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts`

- [ ] **Step 1: Add /font route to router.ts**

In `src/commands/router.ts`, add the import:

```typescript
import { handleFont } from "./handlers";
```

In the `dispatchCommand` switch statement, add a case:

```typescript
case "font":
  return handleFont(rest);
```

- [ ] **Step 2: Add handleFont to handlers.ts**

In `src/commands/handlers.ts`, add the import:

```typescript
import { fontManager, FONT_OPTIONS } from "../fonts/fonts";
import type { MenuResult } from "../overlay/menu";
```

Add the handler function:

```typescript
export function handleFont(args: string): DispatchResult {
  if (!args) {
    // No args → interactive font picker
    const result: MenuResult = {
      type: "menu",
      items: FONT_OPTIONS.map((f) => ({
        label: f.name,
        value: f.name,
        description: f.description,
        active: f.family === fontManager.getCurrent(),
      })),
      onSelect: async (value: string) => {
        const ok = await fontManager.apply(value);
        if (!ok) {
          const { overlay } = await import("../overlay/overlay");
          overlay.showMessage(`Unknown font: ${value}`, true);
        }
      },
      onPreview: (value: string) => {
        // Live preview: temporarily apply font
        const option = FONT_OPTIONS.find((f) => f.name === value);
        if (option) {
          fontManager.apply(option.name);
        }
      },
      onCancel: () => {
        // Restore current font
        fontManager.loadSaved();
      },
    };
    return result;
  }

  // Named font: /font Iosevka
  const option = FONT_OPTIONS.find(
    (f) => f.name.toLowerCase() === args.toLowerCase()
  );
  if (option) {
    fontManager.apply(option.name);
    return { output: `Font: ${option.name}`, isError: false };
  }

  return {
    output: `Unknown font. Available: ${FONT_OPTIONS.map((f) => f.name).join(", ")}`,
    isError: true,
  };
}
```

- [ ] **Step 3: Wire font manager to DOM grid in main.ts**

In `src/main.ts`, add imports and initialization:

```typescript
import { fontManager } from "./fonts/fonts";
```

After DOMGrid initialization, wire the font manager:

```typescript
// ── Font system ───────────────────────────────────────────────────────────
fontManager.setChangeCallback((font, size, ligatures) => {
  domGrid.setFont(font, size, ligatures);
  // Recalculate grid dimensions after font change
  const { rows, cols } = domGrid.measureGrid();
  domGrid.resize(rows, cols);
  invoke("resize_terminal", { rows, cols });
});

// Load saved font preference
fontManager.loadSaved();
```

- [ ] **Step 4: Add Cmd+Plus/Minus shortcuts in main.ts**

In the keyboard handler, add before the ANSI conversion section:

```typescript
// Font size: Cmd+Plus / Cmd+Minus / Cmd+0 (reset)
if (metaKey && (key === "=" || key === "+")) {
  event.preventDefault();
  fontManager.incrementSize(1);
  return;
}
if (metaKey && key === "-") {
  event.preventDefault();
  fontManager.incrementSize(-1);
  return;
}
if (metaKey && key === "0") {
  event.preventDefault();
  fontManager.setSize(14); // reset to default
  return;
}
```

- [ ] **Step 5: Update /help output to include /font**

In `src/commands/handlers.ts`, in the `handleHelp()` function, add an entry to the menu items list:

```typescript
{ label: "/font", value: "font", description: "Change terminal font" },
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: /font command, Cmd+/- font sizing, font manager wired to DOM grid"
```

---

## Phase 6: Integration & Build (Task 10)

### Task 10: Final Integration, Version Bump, and Production Build

Clean up remaining CSS, update version, verify everything works together, build.

**Files:**
- Modify: `src/styles/wallace.css`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src/commands/handlers.ts`

- [ ] **Step 1: Clean up wallace.css — remove Canvas-specific styles**

In `src/styles/wallace.css`, find the `.terminal-viewport` rule (around line 180). The Canvas used to be inside it with `z-index: 1`. Update the viewport to work with the DOM grid:

```css
.terminal-viewport {
  flex: 1;
  position: relative;
  overflow: hidden;
  background: var(--koji-void);
}
```

Remove any `canvas` styling rules inside `.terminal-viewport` if present. The DOM grid's `.terminal-grid` (added in Task 3) takes over.

Also remove the radial glow `::after` pseudo-element if it references the canvas, or keep it if it works as a generic overlay on the viewport (it should — it's positioned absolutely and is purely cosmetic).

- [ ] **Step 2: Update wallace.css — ensure all font-family references use the new pattern**

Search wallace.css for hardcoded `font-family: 'JetBrains Mono'` references in non-grid elements (dashboard, overlay, status bar). These are fine as-is — the font picker only affects the terminal grid, not the UI chrome. Leave them.

- [ ] **Step 3: Version bump**

In `src-tauri/Cargo.toml`, update:

```toml
version = "0.4.0"
```

In `src-tauri/tauri.conf.json`, update:

```json
"version": "0.4.0"
```

In `src/commands/handlers.ts`, update `handleVersion()`:

```typescript
export function handleVersion(): CommandResult {
  return { output: "Kōji Baseline v0.4.0", isError: false };
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

- [ ] **Step 6: Full production build**

```bash
cd /Users/hanamori/koji-baseline && npm run tauri build
```

Expected: macOS .app bundle and DMG at `src-tauri/target/release/bundle/`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: Kōji Baseline v0.4.0 — DOM grid, curated fonts, scrollback, clipboard, performance pivot"
```
