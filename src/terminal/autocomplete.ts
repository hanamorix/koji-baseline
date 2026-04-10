// autocomplete.ts — Inline ghost-text autosuggestion at the cursor position
// Matches against slash commands and shell history. Fish shell style.

import type { DOMGrid } from "./dom-grid";

const SLASH_COMMANDS = [
  "/help",
  "/version",
  "/theme",
  "/font",
  "/llm",
  "/llm models",
  "/llm recommend",
  "/llm autorun off",
  "/llm autorun safe",
  "/llm autorun full",
  "/agent",
  "/exit",
];

export class Autocomplete {
  private grid: DOMGrid;
  private inlineGhostEl: HTMLSpanElement | null = null;
  private currentSuggestion = "";
  private shellHistory: string[] = [];

  constructor(_container: HTMLElement, grid: DOMGrid) {
    this.grid = grid;
  }

  /** Add a command to shell history. */
  addToHistory(cmd: string): void {
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Update ghost suggestion at the cursor position. */
  update(input: string): string {
    this.clearGhost();

    if (!input) {
      this.currentSuggestion = "";
      return "";
    }

    // Find suggestion
    let match = "";
    if (input.startsWith("/")) {
      const lower = input.toLowerCase();
      match = SLASH_COMMANDS.find((cmd) =>
        cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower
      ) ?? "";
    } else {
      for (let i = this.shellHistory.length - 1; i >= 0; i--) {
        if (this.shellHistory[i].startsWith(input) && this.shellHistory[i] !== input) {
          match = this.shellHistory[i];
          break;
        }
      }
    }

    this.currentSuggestion = match;

    if (match) {
      const completion = match.slice(input.length);
      this.showGhost(completion);
    }

    return this.currentSuggestion;
  }

  /** Accept the current suggestion. Returns the full command or empty. */
  accept(): string {
    const suggestion = this.currentSuggestion;
    this.currentSuggestion = "";
    this.clearGhost();
    return suggestion;
  }

  /** Dismiss the ghost. */
  hide(): void {
    this.clearGhost();
    this.currentSuggestion = "";
  }

  /** Get current suggestion without accepting. */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  private showGhost(completion: string): void {
    const { row, col } = this.grid.getCursorPos();
    const rowEl = this.grid.getRowElement(row);
    if (!rowEl) return;

    this.inlineGhostEl = document.createElement("span");
    this.inlineGhostEl.className = "inline-ghost";
    this.inlineGhostEl.textContent = completion;

    const cursorCell = rowEl.children[col] as HTMLElement | undefined;
    if (cursorCell && cursorCell.nextSibling) {
      rowEl.insertBefore(this.inlineGhostEl, cursorCell.nextSibling);
    } else {
      rowEl.appendChild(this.inlineGhostEl);
    }
  }

  private clearGhost(): void {
    if (this.inlineGhostEl) {
      this.inlineGhostEl.remove();
      this.inlineGhostEl = null;
    }
  }
}
