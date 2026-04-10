// grid.ts — Canvas 2D terminal grid renderer
// Paints the full GridSnapshot every frame. Cursor breathes. Wallace amber on.
// Scrollback fade dims lines above the cursor — atmosphere layer 1.
// Task 10: Inline LLM response block rendered below the cursor row.

import { applyScrollbackFade } from "./scrollback";

const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
const FONT_FAMILY = "'JetBrains Mono', 'Courier New', monospace";

// LLM response render config
const LLM_FG = "#cc7a00";
const LLM_BORDER = "#4a3a1a";
const LLM_BORDER_WIDTH = 2;
const LLM_PAD_LEFT = 6; // pixels from left edge (border + gap)

// ─── Types (mirror Rust GridSnapshot) ─────────────────────────────────────────

interface RenderCell {
  character: string;
  fg: [number, number, number];
  bg: [number, number, number];
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
}

interface CursorPos {
  row: number;
  col: number;
}

export interface GridSnapshot {
  cells: RenderCell[][];
  cursor: CursorPos;
  rows: number;
  cols: number;
}

// ─── LLM overlay state ────────────────────────────────────────────────────────

interface LlmState {
  text: string;
  done: boolean;
  afterRow: number;
}

// ─── TerminalGrid ──────────────────────────────────────────────────────────────

export class TerminalGrid {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cursorOpacity = 1.0;
  private cursorAnimStart: number | null = null;
  private rafHandle = 0;
  private lastSnapshot: GridSnapshot | null = null;
  private llmState: LlmState | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    // Default size — will be updated by resize() or first render()
    this.resize(24, 80);
    this.startCursorAnimation();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  resize(rows: number, cols: number): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = cols * CELL_WIDTH * dpr;
    this.canvas.height = rows * CELL_HEIGHT * dpr;
    this.canvas.style.width = `${cols * CELL_WIDTH}px`;
    this.canvas.style.height = `${rows * CELL_HEIGHT}px`;
    this.ctx.scale(dpr, dpr);

    // Immediately redraw to avoid blank flash after resize
    if (this.lastSnapshot) {
      this.drawGrid(this.lastSnapshot);
    }
  }

  render(snapshot: GridSnapshot): void {
    const dpr = window.devicePixelRatio || 1;
    if (
      this.canvas.width !== snapshot.cols * CELL_WIDTH * dpr ||
      this.canvas.height !== snapshot.rows * CELL_HEIGHT * dpr
    ) {
      this.resize(snapshot.rows, snapshot.cols);
    }
    this.lastSnapshot = snapshot;
    this.drawGrid(snapshot);
  }

  /** Called by the LLM panel on every streaming token batch. */
  setLlmResponse(text: string, done: boolean, afterRow: number): void {
    this.llmState = { text, done, afterRow };
    // Redraw immediately so the user sees tokens arriving
    if (this.lastSnapshot) {
      this.drawGrid(this.lastSnapshot);
    }
  }

  /** Expose the last snapshot so main.ts can read cursor position. */
  getLastSnapshot(): GridSnapshot | null {
    return this.lastSnapshot;
  }

  getCellFromClick(event: MouseEvent): { row: number; col: number } {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const col = Math.floor(x / CELL_WIDTH);
    const row = Math.floor(y / CELL_HEIGHT);
    return { row, col };
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /** Cancel the cursor animation RAF — call when unmounting the grid. */
  destroy(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
  }

  // ─── Private rendering ───────────────────────────────────────────────────────

  private startCursorAnimation(): void {
    const tick = (timestamp: number) => {
      if (this.cursorAnimStart === null) this.cursorAnimStart = timestamp;
      const elapsed = (timestamp - this.cursorAnimStart) / 2000;
      this.cursorOpacity = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2));

      if (this.lastSnapshot) {
        this.drawCursor(this.lastSnapshot);
      }

      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private drawGrid(snapshot: GridSnapshot): void {
    const { ctx } = this;

    ctx.font = `${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = "top";

    for (let row = 0; row < snapshot.rows; row++) {
      for (let col = 0; col < snapshot.cols; col++) {
        const cell = snapshot.cells[row]?.[col];
        if (!cell) continue;

        const x = col * CELL_WIDTH;
        const y = row * CELL_HEIGHT;

        // Background
        ctx.fillStyle = rgbToHex(cell.bg);
        ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);

        if (cell.character && cell.character.trim() !== "") {
          const fadedFg = applyScrollbackFade(cell.fg, row, snapshot.rows, snapshot.cursor.row);
          ctx.fillStyle = rgbToHex(fadedFg);
          ctx.font = buildFont(cell.bold, cell.italic);
          ctx.globalAlpha = cell.dim ? 0.5 : 1.0;
          ctx.fillText(cell.character, x, y + 1);
          ctx.globalAlpha = 1.0;

          if (cell.underline) {
            ctx.fillStyle = rgbToHex(fadedFg);
            ctx.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH, 1);
          }
        }
      }
    }

    // LLM overlay — rendered after grid cells so it sits on top
    this.drawLlmResponse();

    // Cursor on top of everything
    this.drawCursor(snapshot);
  }

  /**
   * Renders the LLM response text below the cursor row with:
   *   - 2px amber-dark left border
   *   - Text in amber (#cc7a00)
   *   - Word-wrapping at canvas width
   */
  private drawLlmResponse(): void {
    if (!this.llmState || !this.lastSnapshot) return;
    const { text, afterRow } = this.llmState;
    if (!text) return;

    const { ctx } = this;
    // Use logical pixel dimensions (CSS size), not physical canvas dimensions
    const logicalWidth = parseFloat(this.canvas.style.width) || this.canvas.width;
    const logicalHeight = parseFloat(this.canvas.style.height) || this.canvas.height;
    const startY = (afterRow + 1) * CELL_HEIGHT;

    // Hard-clip to canvas bottom — don't render off-screen
    if (startY >= logicalHeight) return;

    const maxWidth = logicalWidth - LLM_PAD_LEFT - 4;

    // Left border
    ctx.save();
    ctx.fillStyle = LLM_BORDER;
    ctx.fillRect(0, startY, LLM_BORDER_WIDTH, logicalHeight - startY);

    // Wrap and render text lines
    ctx.fillStyle = LLM_FG;
    ctx.font = `normal normal ${FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = "top";
    ctx.globalAlpha = 1.0;

    const lines = wrapText(ctx, text, maxWidth);
    let y = startY + 2; // 2px padding from border top

    for (const line of lines) {
      if (y + CELL_HEIGHT > logicalHeight) break; // ran out of canvas
      ctx.fillText(line, LLM_PAD_LEFT, y);
      y += CELL_HEIGHT;
    }

    ctx.restore();
  }

  private drawCursor(snapshot: GridSnapshot): void {
    const { row, col } = snapshot.cursor;
    if (row >= snapshot.rows || col >= snapshot.cols) return;

    const x = col * CELL_WIDTH;
    const y = row * CELL_HEIGHT;

    // Clean amber beam cursor — 2px vertical line
    this.ctx.save();
    this.ctx.globalAlpha = this.cursorOpacity;
    this.ctx.fillStyle = "#ff8c00";
    this.ctx.fillRect(x, y, 2, CELL_HEIGHT);
    this.ctx.restore();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rgbToHex([r, g, b]: [number, number, number]): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}

function buildFont(bold: boolean, italic: boolean): string {
  const weight = bold ? "bold" : "normal";
  const style = italic ? "italic" : "normal";
  return `${style} ${weight} ${FONT_SIZE}px ${FONT_FAMILY}`;
}

/**
 * Splits `text` into lines that fit within `maxWidth` pixels.
 * Honours existing newlines first, then wraps long lines by word.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const result: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      result.push("");
      continue;
    }

    const words = paragraph.split(" ");
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
      } else {
        if (line) result.push(line);
        // If a single word is wider than maxWidth, push it anyway
        line = word;
      }
    }

    if (line) result.push(line);
  }

  return result;
}
