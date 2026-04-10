// autocomplete.ts — Command input bar + inline ghost-text autosuggestion
// Slash commands and >> queries: shows a visible input bar at the bottom.
// Regular shell commands: shows ghost text inline at the cursor position.

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

  // Command input bar (for / and >> commands)
  private barEl: HTMLDivElement;
  private prefixEl: HTMLSpanElement;
  private textEl: HTMLSpanElement;
  private barGhostEl: HTMLSpanElement;
  private cursorEl: HTMLSpanElement;
  private barVisible = false;

  // Inline ghost (for shell commands — rendered in the grid row)
  private inlineGhostEl: HTMLSpanElement | null = null;

  private currentSuggestion = "";
  private shellHistory: string[] = [];

  constructor(container: HTMLElement, grid: DOMGrid) {
    this.grid = grid;

    // Build the command input bar
    this.barEl = document.createElement("div");
    this.barEl.className = "command-input-bar";

    this.prefixEl = document.createElement("span");
    this.prefixEl.className = "input-prefix";

    this.textEl = document.createElement("span");
    this.textEl.className = "input-text";

    this.barGhostEl = document.createElement("span");
    this.barGhostEl.className = "input-ghost";

    this.cursorEl = document.createElement("span");
    this.cursorEl.className = "input-cursor";

    this.barEl.appendChild(this.prefixEl);
    this.barEl.appendChild(this.textEl);
    this.barEl.appendChild(this.cursorEl);
    this.barEl.appendChild(this.barGhostEl);

    container.appendChild(this.barEl);
  }

  /** Add a command to shell history. */
  addToHistory(cmd: string): void {
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Update display and ghost suggestion based on current input. */
  update(input: string): string {
    // Clear previous inline ghost
    this.clearInlineGhost();

    if (!input) {
      this.hideBar();
      this.currentSuggestion = "";
      return "";
    }

    const isIntercepted = input.startsWith("/") || input.startsWith(">>");

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
    const completion = match ? match.slice(input.length) : "";

    if (isIntercepted) {
      // Show command input bar for / and >> commands
      this.showBar(input);
      this.barGhostEl.textContent = completion;
    } else {
      // Hide bar, show inline ghost at cursor for shell commands
      this.hideBar();
      if (completion) {
        this.showInlineGhost(completion);
      }
    }

    return this.currentSuggestion;
  }

  /** Accept the current suggestion. Returns the full command or empty. */
  accept(): string {
    const suggestion = this.currentSuggestion;
    this.currentSuggestion = "";
    this.clearInlineGhost();
    return suggestion;
  }

  /** Dismiss everything. */
  hide(): void {
    this.hideBar();
    this.clearInlineGhost();
    this.currentSuggestion = "";
  }

  /** Get current suggestion without accepting. */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  // ── Command input bar (for / and >>) ──────────────────────────────────

  private showBar(input: string): void {
    if (input.startsWith(">>")) {
      this.prefixEl.textContent = ">>";
      this.textEl.textContent = input.slice(2);
    } else if (input.startsWith("/")) {
      this.prefixEl.textContent = "/";
      this.textEl.textContent = input.slice(1);
    }

    if (!this.barVisible) {
      this.barEl.classList.add("active");
      this.barVisible = true;
    }
  }

  private hideBar(): void {
    if (this.barVisible) {
      this.barEl.classList.remove("active");
      this.barVisible = false;
      this.textEl.textContent = "";
      this.barGhostEl.textContent = "";
      this.prefixEl.textContent = "";
    }
  }

  // ── Inline ghost (for shell commands) ─────────────────────────────────

  private showInlineGhost(completion: string): void {
    const { row, col } = this.grid.getCursorPos();
    const rowEl = this.grid.getRowElement(row);
    if (!rowEl) return;

    // Create a ghost span and insert it after the cursor cell
    this.inlineGhostEl = document.createElement("span");
    this.inlineGhostEl.className = "inline-ghost";
    this.inlineGhostEl.textContent = completion;

    // Insert after the cursor position's cell
    const cursorCell = rowEl.children[col] as HTMLElement | undefined;
    if (cursorCell && cursorCell.nextSibling) {
      rowEl.insertBefore(this.inlineGhostEl, cursorCell.nextSibling);
    } else {
      rowEl.appendChild(this.inlineGhostEl);
    }
  }

  private clearInlineGhost(): void {
    if (this.inlineGhostEl) {
      this.inlineGhostEl.remove();
      this.inlineGhostEl = null;
    }
  }
}
