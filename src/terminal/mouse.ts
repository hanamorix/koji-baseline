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

  updateMode(mouseMode: number): void {
    const shouldBeActive = mouseMode > 0;
    if (shouldBeActive !== this.active) {
      this.active = shouldBeActive;
      this.gridEl.style.userSelect = this.active ? "none" : "";
    }
  }

  private setupListeners(): void {
    this.gridEl.addEventListener("mousedown", (e) => {
      if (!this.active || e.shiftKey) return;
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
        this.sendSGR(35, pos.col, pos.row, "M", e);
      }
    });

    this.gridEl.addEventListener("wheel", (e) => {
      if (!this.active || e.shiftKey) return;
      e.preventDefault();
      const pos = this.grid.getCellFromMouse(e as unknown as MouseEvent);
      if (!pos) return;
      const button = e.deltaY < 0 ? 64 : 65;
      this.sendSGR(button, pos.col, pos.row, "M", e as unknown as MouseEvent);
    });
  }

  private sendSGR(button: number, col: number, row: number, suffix: "M" | "m", e: MouseEvent): void {
    let btn = button;
    if (e.shiftKey) btn |= 4;
    if (e.altKey) btn |= 8;
    if (e.ctrlKey) btn |= 16;

    const seq = `\x1b[<${btn};${col + 1};${row + 1}${suffix}`;
    const bytes = Array.from(new TextEncoder().encode(seq));
    invoke("write_to_pty", { data: bytes }).catch(console.error);
  }
}
