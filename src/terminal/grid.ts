// grid.ts — Canvas 2D terminal grid renderer
// Paints the full GridSnapshot every frame. Cursor breathes. Wallace amber on.
// Scrollback fade dims lines above the cursor — atmosphere layer 1.

import { applyScrollbackFade } from "./scrollback";

const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
const FONT_FAMILY = "'JetBrains Mono', 'Courier New', monospace";

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

// ─── TerminalGrid ──────────────────────────────────────────────────────────────

export class TerminalGrid {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cursorOpacity = 1.0;
  private cursorAnimStart: number | null = null;
  private rafId: number | null = null;
  private lastSnapshot: GridSnapshot | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.imageRendering = "pixelated";
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
    this.canvas.width = cols * CELL_WIDTH;
    this.canvas.height = rows * CELL_HEIGHT;
  }

  render(snapshot: GridSnapshot): void {
    // Resize canvas if grid dimensions changed
    if (
      this.canvas.width !== snapshot.cols * CELL_WIDTH ||
      this.canvas.height !== snapshot.rows * CELL_HEIGHT
    ) {
      this.resize(snapshot.rows, snapshot.cols);
    }
    this.lastSnapshot = snapshot;
    this.drawGrid(snapshot);
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

  // ─── Private rendering ───────────────────────────────────────────────────────

  private startCursorAnimation(): void {
    const tick = (timestamp: number) => {
      if (this.cursorAnimStart === null) this.cursorAnimStart = timestamp;
      // Pulse 0.4 → 1.0 over ~2 seconds (sine wave, always positive)
      const elapsed = (timestamp - this.cursorAnimStart) / 2000;
      this.cursorOpacity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(elapsed * Math.PI * 2));

      // Redraw only the cursor cell if we have a snapshot
      if (this.lastSnapshot) {
        this.drawCursor(this.lastSnapshot);
      }

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
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

        // Character — apply scrollback fade above cursor row
        if (cell.character && cell.character.trim() !== "") {
          const fadedFg = applyScrollbackFade(cell.fg, row, snapshot.rows, snapshot.cursor.row);
          ctx.fillStyle = rgbToHex(fadedFg);
          ctx.font = buildFont(cell.bold, cell.italic);
          ctx.globalAlpha = cell.dim ? 0.5 : 1.0;
          ctx.fillText(cell.character, x, y + 1);
          ctx.globalAlpha = 1.0;

          // Underline
          if (cell.underline) {
            ctx.fillStyle = rgbToHex(fadedFg);
            ctx.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH, 1);
          }
        }
      }
    }

    // Draw cursor on top
    this.drawCursor(snapshot);
  }

  private drawCursor(snapshot: GridSnapshot): void {
    const { ctx } = this;
    const { row, col } = snapshot.cursor;

    // Bounds check
    if (row >= snapshot.rows || col >= snapshot.cols) return;

    const x = col * CELL_WIDTH;
    const y = row * CELL_HEIGHT;

    // Redraw the cell underneath so we don't stack alphas
    const cell = snapshot.cells[row]?.[col];
    if (cell) {
      ctx.fillStyle = rgbToHex(cell.bg);
      ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);
      if (cell.character && cell.character.trim() !== "") {
        ctx.fillStyle = rgbToHex(cell.fg);
        ctx.font = buildFont(cell.bold, cell.italic);
        ctx.globalAlpha = cell.dim ? 0.5 : 1.0;
        ctx.fillText(cell.character, x, y + 1);
        ctx.globalAlpha = 1.0;
      }
    }

    // Cursor block — amber glow, breathing opacity
    ctx.save();
    ctx.globalAlpha = this.cursorOpacity;
    ctx.shadowColor = "#ff8c00";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "#ff8c00";
    ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);
    ctx.restore();

    // Character on top of cursor in dark ink so it's readable
    if (cell && cell.character && cell.character.trim() !== "") {
      ctx.save();
      ctx.globalAlpha = this.cursorOpacity;
      ctx.fillStyle = "#0a0a0a";
      ctx.font = buildFont(cell.bold, cell.italic);
      ctx.fillText(cell.character, x, y + 1);
      ctx.restore();
    }
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
