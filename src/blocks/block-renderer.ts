// block-renderer.ts — Renders command blocks as overlay decorations on the terminal grid
// Each OSC 133 zone becomes a visual block with header, border, footer.

import type { CommandZone } from "../tabs/tab-session";
import type { DOMGrid } from "../terminal/dom-grid";

export class BlockRenderer {
  private scrollEl: HTMLElement;
  private grid: DOMGrid;
  private blockEls: HTMLElement[] = [];
  private enabled = true;

  constructor(grid: DOMGrid) {
    this.grid = grid;
    this.scrollEl = grid.getScrollElement();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  isEnabled(): boolean { return this.enabled; }

  /** Re-render all blocks from zone data */
  render(zones: CommandZone[], _writePty: (data: number[]) => Promise<void>): void {
    if (!this.enabled) return;
    this.clear();

    const lineHeight = this.grid.getFontSize() * 1.3;

    for (const zone of zones) {
      // Only render completed zones
      if (zone.end_line === null || zone.exit_code === null) continue;

      const block = document.createElement("div");
      block.className = "cmd-block";
      block.classList.add(zone.exit_code === 0 ? "cmd-block-success" : "cmd-block-error");

      // Position over the zone's grid rows
      const top = zone.prompt_line * lineHeight;
      const height = (zone.end_line - zone.prompt_line + 1) * lineHeight;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      // Header: extract command text from grid rows
      const commandText = this.extractText(zone.input_line ?? zone.prompt_line, zone.output_line ?? zone.end_line);
      const header = document.createElement("div");
      header.className = "cmd-block-header";

      const cmdSpan = document.createElement("span");
      cmdSpan.className = "cmd-block-cmd";
      cmdSpan.textContent = `$ ${commandText.trim().split("\n")[0]}`;
      header.appendChild(cmdSpan);

      const exitBadge = document.createElement("span");
      exitBadge.className = "cmd-block-exit";
      exitBadge.textContent = zone.exit_code === 0 ? "\u2713" : `\u2717 ${zone.exit_code}`;
      header.appendChild(exitBadge);

      block.appendChild(header);

      // Footer: duration + actions
      const footer = document.createElement("div");
      footer.className = "cmd-block-footer";

      if (zone.start_time > 0 && zone.end_time) {
        const durationS = Math.round((zone.end_time - zone.start_time) / 1000);
        if (durationS > 0) {
          const dur = document.createElement("span");
          dur.className = "cmd-block-duration";
          dur.textContent = `${durationS}s`;
          footer.appendChild(dur);
        }
      }

      // Copy output button
      const copyBtn = document.createElement("button");
      copyBtn.className = "cmd-block-action";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const outputText = this.extractText(zone.output_line ?? zone.prompt_line, zone.end_line!);
        navigator.clipboard.writeText(outputText).catch(console.warn);
      });
      footer.appendChild(copyBtn);

      // Collapse toggle
      let collapsed = false;
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "cmd-block-action";
      collapseBtn.textContent = "\u25be";
      collapseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsed = !collapsed;
        collapseBtn.textContent = collapsed ? "\u25b8" : "\u25be";
        block.classList.toggle("cmd-block-collapsed", collapsed);
        if (collapsed) {
          block.style.height = `${lineHeight * 1.5}px`;
        } else {
          block.style.height = `${height}px`;
        }
      });
      footer.appendChild(collapseBtn);

      block.appendChild(footer);
      this.scrollEl.appendChild(block);
      this.blockEls.push(block);
    }
  }

  clear(): void {
    for (const el of this.blockEls) el.remove();
    this.blockEls = [];
  }

  private extractText(startLine: number, endLine: number): string {
    const rows = this.scrollEl.querySelectorAll(".grid-row");
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < rows.length; i++) {
      lines.push(rows[i].textContent ?? "");
    }
    return lines.join("\n");
  }
}
