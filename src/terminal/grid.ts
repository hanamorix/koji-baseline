// grid.ts — Canvas 2D terminal grid renderer
// Paints the full GridSnapshot every frame. Cursor breathes. Wallace amber on.
// Scrollback fade dims lines above the cursor — atmosphere layer 1.

import { applyScrollbackFade } from "./scrollback";
import { ClickableRegion, findRegionAt } from "./clickable";

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
  private rafHandle = 0;
  private lastSnapshot: GridSnapshot | null = null;
  private clickableRegions: ClickableRegion[] = [];
  private hoveredRegion: ClickableRegion | null = null;

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

  setClickableRegions(regions: ClickableRegion[]): void {
    this.clickableRegions = regions;
    if (this.lastSnapshot) this.drawGrid(this.lastSnapshot);
  }

  getClickableRegions(): ClickableRegion[] {
    return this.clickableRegions;
  }

  /**
   * Update the hovered region, flip the cursor style on the canvas element,
   * and trigger an immediate redraw so the underline appears / disappears.
   */
  setHoveredRegion(region: ClickableRegion | null): void {
    this.hoveredRegion = region;
    this.canvas.style.cursor = region ? "pointer" : "default";
    if (this.lastSnapshot) this.drawGrid(this.lastSnapshot);
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
          ctx.font = buildFont(cell.bold, cell.italic);
          ctx.globalAlpha = cell.dim ? 0.5 : 1.0;

          // Clickable region highlight — accent colour overrides normal fg
          const region = findRegionAt(this.clickableRegions, row, col);
          if (region) {
            const accentColor = getComputedStyle(document.documentElement)
              .getPropertyValue("--koji-orange").trim() || "#cc7a00";
            ctx.fillStyle = accentColor;
          } else {
            ctx.fillStyle = rgbToHex(fadedFg);
          }

          ctx.fillText(cell.character, x, y + 1);
          ctx.globalAlpha = 1.0;

          if (cell.underline) {
            ctx.fillStyle = rgbToHex(fadedFg);
            ctx.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH, 1);
          }

          // Hover underline — 1px below character in accent colour
          if (region && region === this.hoveredRegion) {
            const accentColor = getComputedStyle(document.documentElement)
              .getPropertyValue("--koji-orange").trim() || "#cc7a00";
            ctx.fillStyle = accentColor;
            ctx.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH, 1);
          }
        }
      }
    }

    // Cursor on top of everything
    this.drawCursor(snapshot);
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

