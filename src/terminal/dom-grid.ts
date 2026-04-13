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
  strikethrough?: boolean;
  hidden?: boolean;
  blink?: boolean;
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
  is_alt_screen: boolean;
  mouse_mode: number;
  title: string;
}

interface RowState {
  el: HTMLDivElement;
  hash: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cellHash(cell: RenderCell): string {
  return `${cell.character}|${cell.fg[0]},${cell.fg[1]},${cell.fg[2]}|${cell.bg[0]},${cell.bg[1]},${cell.bg[2]}|${cell.bold ? 1 : 0}${cell.italic ? 1 : 0}${cell.underline ? 1 : 0}${cell.dim ? 1 : 0}${cell.wide ? 1 : 0}${cell.strikethrough ? 1 : 0}${cell.hidden ? 1 : 0}${cell.blink ? 1 : 0}`;
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
    if (cell.hidden) style += "visibility:hidden;";

    // Compose text-decoration from underline + strikethrough
    const decorations: string[] = [];
    if (cell.underline) decorations.push("underline");
    if (cell.strikethrough) decorations.push("line-through");
    if (decorations.length > 0) style += `text-decoration:${decorations.join(" ")};`;

    let cls = cell.wide ? "cell wide" : "cell";
    if (cell.blink) cls += " cell-blink";

    html += `<span class="${cls}" style="${style}">${char}</span>`;
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
  private scrollbackRows: HTMLDivElement[] = [];
  private maxScrollback = 10000;
  private cursorRow = -1;
  private cursorCol = -1;
  private lastSnapshot: GridSnapshot | null = null;
  private pendingSnapshot: GridSnapshot | null = null;
  private rafPending = false;
  private scrollbarTimer: ReturnType<typeof setTimeout> | null = null;
  private inAltScreen = false;
  private autoScroll = true;
  private fontFamily = "'JetBrains Mono', 'Apple Color Emoji', 'Hiragino Sans', 'Noto Sans CJK SC', monospace";
  private fontSize = 14;
  private ligatures = true;
  private cursorStyle: "block" | "beam" | "underline" = "block";
  private cachedCharWidth = 0;
  private cachedLineHeight = 0;

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

  resize(rows: number, _cols: number): void {
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

  /** Invalidate all row hashes so the next render rebuilds every row.
   *  Call after theme changes — inline styles need regeneration from new colors. */
  invalidateAllRows(): void {
    for (const row of this.viewportRows) {
      row.hash = "";
    }
  }

  getCursorPos(): { row: number; col: number } {
    return { row: this.cursorRow, col: this.cursorCol };
  }

  /** Get the DOM element for a viewport row. */
  getRowElement(row: number): HTMLDivElement | null {
    if (row >= 0 && row < this.viewportRows.length) {
      return this.viewportRows[row].el;
    }
    return null;
  }

  getScrollElement(): HTMLDivElement {
    return this.scrollEl;
  }

  getMouseMode(): number {
    return this.lastSnapshot?.mouse_mode ?? 0;
  }

  getCellFromMouse(event: MouseEvent): { row: number; col: number } | null {
    // Use cached dimensions for arithmetic (avoids DOM queries per-cell)
    if (this.cachedCharWidth === 0) this.measureGrid(); // ensure cache populated
    const gridRect = this.gridEl.getBoundingClientRect();
    const x = event.clientX - gridRect.left;
    const y = event.clientY - gridRect.top + this.scrollEl.scrollTop;

    const row = Math.floor(y / this.cachedLineHeight) - this.scrollbackRows.length;
    const col = Math.floor(x / this.cachedCharWidth);

    if (row < 0 || row >= this.viewportRows.length) return null;
    return { row: Math.max(0, row), col: Math.max(0, col) };
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

  /** Calculate grid dimensions from container size and cached font metrics. */
  measureGrid(): { rows: number; cols: number } {
    // Use cached dimensions if available (invalidated by font changes)
    if (this.cachedCharWidth === 0) {
      const measure = document.createElement("span");
      measure.className = "cell";
      measure.style.fontFamily = this.fontFamily;
      measure.style.fontSize = `${this.fontSize}px`;
      measure.style.position = "absolute";
      measure.style.visibility = "hidden";
      measure.textContent = "W";
      this.container.appendChild(measure);
      this.cachedCharWidth = measure.getBoundingClientRect().width;
      this.cachedLineHeight = this.fontSize * 1.3;
      measure.remove();
    }

    const containerRect = this.container.getBoundingClientRect();
    const cols = Math.floor(containerRect.width / this.cachedCharWidth);
    const rows = Math.floor(containerRect.height / this.cachedLineHeight);

    return { rows: Math.max(1, rows), cols: Math.max(1, cols) };
  }

  destroy(): void {
    this.gridEl.remove();
    if (this.scrollbarTimer) clearTimeout(this.scrollbarTimer);
    // Release large data structures for GC
    this.scrollbackRows = [];
    this.viewportRows = [];
    this.lastSnapshot = null;
    this.pendingSnapshot = null;
  }

  /** Append scrollback rows above the viewport. Called when lines scroll off the top. */
  appendScrollback(rows: RenderCell[][]): void {
    if (rows.length === 0) return;

    // Build all elements into a fragment — one DOM insertion instead of N
    const fragment = document.createDocumentFragment();
    for (const cells of rows) {
      const el = document.createElement("div");
      el.className = "grid-row";
      el.innerHTML = buildRowHTML(cells);
      if (this.inAltScreen) el.style.display = "none";
      fragment.appendChild(el);
      this.scrollbackRows.push(el);
    }

    if (this.viewportRows.length > 0) {
      this.scrollEl.insertBefore(fragment, this.viewportRows[0].el);
    } else {
      this.scrollEl.appendChild(fragment);
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

  clearScrollback(): void {
    for (const row of this.scrollbackRows) {
      row.remove();
    }
    this.scrollbackRows = [];
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private applyFontStyles(): void {
    this.scrollEl.style.fontFamily = this.fontFamily;
    this.scrollEl.style.fontSize = `${this.fontSize}px`;
    this.scrollEl.style.fontVariantLigatures = this.ligatures ? "normal" : "none";
    // Invalidate dimension cache — font change means new char width
    this.cachedCharWidth = 0;
    this.cachedLineHeight = 0;
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

  setCursorStyle(style: "block" | "beam" | "underline"): void {
    this.cursorStyle = style;
    if (this.lastSnapshot) this.updateCursor(this.lastSnapshot.cursor);
  }

  private updateCursor(cursor: CursorPos): void {
    const cursorClass = `cell--cursor-${this.cursorStyle}`;

    // Remove old cursor (all variants)
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
}
