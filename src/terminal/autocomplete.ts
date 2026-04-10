// autocomplete.ts — Floating ghost text + suggestion dropdown
// Ghost text floats over the grid at the cursor position (survives re-renders).
// Dropdown shows file/directory completions and history matches.

import { invoke } from "@tauri-apps/api/core";
import type { DOMGrid } from "./dom-grid";

const SLASH_COMMANDS = [
  "/help", "/version", "/theme", "/font", "/llm", "/llm models",
  "/llm recommend", "/llm autorun off", "/llm autorun safe",
  "/llm autorun full", "/agent", "/exit",
];

// Commands that take path arguments
const PATH_COMMANDS = new Set([
  "cd", "ls", "cat", "less", "more", "head", "tail", "vim", "nvim",
  "nano", "code", "open", "rm", "cp", "mv", "mkdir", "touch",
  "chmod", "chown", "find", "grep", "rg", "bat", "source", ".",
]);

interface Suggestion {
  text: string;
  kind: "history" | "command" | "file" | "directory";
}

export class Autocomplete {
  private grid: DOMGrid;
  private ghostEl: HTMLDivElement;
  private dropdownEl: HTMLDivElement;
  private currentSuggestion = "";
  private suggestions: Suggestion[] = [];
  private selectedIndex = -1;
  private shellHistory: string[] = [];
  private visible = false;
  private dropdownVisible = false;
  private pendingPathQuery: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, grid: DOMGrid) {
    this.grid = grid;

    // Floating ghost text — positioned absolutely over the grid
    this.ghostEl = document.createElement("div");
    this.ghostEl.className = "ghost-float";
    container.appendChild(this.ghostEl);

    // Suggestion dropdown
    this.dropdownEl = document.createElement("div");
    this.dropdownEl.className = "suggest-dropdown";
    container.appendChild(this.dropdownEl);
  }

  addToHistory(cmd: string): void {
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Update suggestions based on current input. Call after every keystroke. */
  update(input: string): void {
    if (!input) {
      this.hide();
      return;
    }

    // Build suggestion list
    this.suggestions = [];
    this.selectedIndex = -1;

    if (input.startsWith("/")) {
      // Slash command suggestions
      const lower = input.toLowerCase();
      for (const cmd of SLASH_COMMANDS) {
        if (cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) {
          this.suggestions.push({ text: cmd, kind: "command" });
        }
      }
    } else {
      // Shell history suggestions (most recent first)
      for (let i = this.shellHistory.length - 1; i >= 0; i--) {
        if (this.shellHistory[i].startsWith(input) && this.shellHistory[i] !== input) {
          this.suggestions.push({ text: this.shellHistory[i], kind: "history" });
          if (this.suggestions.length >= 5) break;
        }
      }

      // Path completion — check if we're typing a path argument
      this.checkPathCompletion(input);
    }

    if (this.suggestions.length > 0) {
      this.currentSuggestion = this.suggestions[0].text;
      this.showGhost(this.suggestions[0].text.slice(input.length));
      if (this.suggestions.length > 1) {
        this.showDropdown(input);
      } else {
        this.hideDropdown();
      }
    } else {
      this.currentSuggestion = "";
      this.hideGhost();
      this.hideDropdown();
    }
  }

  /** Navigate dropdown: -1 for up, +1 for down. Returns true if handled. */
  navigate(delta: number): boolean {
    if (!this.dropdownVisible || this.suggestions.length === 0) return false;

    this.selectedIndex += delta;
    if (this.selectedIndex < 0) this.selectedIndex = this.suggestions.length - 1;
    if (this.selectedIndex >= this.suggestions.length) this.selectedIndex = 0;

    this.currentSuggestion = this.suggestions[this.selectedIndex].text;
    this.renderDropdown();
    return true;
  }

  /** Accept the current suggestion. Returns the full text or empty. */
  accept(): string {
    const suggestion = this.currentSuggestion;
    this.hide();
    return suggestion;
  }

  hide(): void {
    this.hideGhost();
    this.hideDropdown();
    this.currentSuggestion = "";
    this.suggestions = [];
    this.selectedIndex = -1;
    if (this.pendingPathQuery) {
      clearTimeout(this.pendingPathQuery);
      this.pendingPathQuery = null;
    }
  }

  getSuggestion(): string {
    return this.currentSuggestion;
  }

  isDropdownOpen(): boolean {
    return this.dropdownVisible;
  }

  // ── Ghost text (floating overlay at cursor) ───────────────────────────

  private showGhost(completion: string): void {
    const pos = this.getCursorPixelPos();
    if (!pos) { this.hideGhost(); return; }

    this.ghostEl.textContent = completion;
    this.ghostEl.style.left = `${pos.x}px`;
    this.ghostEl.style.top = `${pos.y}px`;
    this.ghostEl.style.display = "block";
    this.visible = true;
  }

  private hideGhost(): void {
    if (this.visible) {
      this.ghostEl.style.display = "none";
      this.visible = false;
    }
  }

  // ── Suggestion dropdown ───────────────────────────────────────────────

  private showDropdown(_input: string): void {
    const pos = this.getCursorPixelPos();
    if (!pos) { this.hideDropdown(); return; }

    this.dropdownEl.style.left = `${pos.x}px`;
    // Position below the cursor line
    this.dropdownEl.style.top = `${pos.y + pos.lineHeight}px`;
    this.renderDropdown();
    this.dropdownEl.style.display = "block";
    this.dropdownVisible = true;
  }

  private hideDropdown(): void {
    if (this.dropdownVisible) {
      this.dropdownEl.style.display = "none";
      this.dropdownVisible = false;
    }
  }

  private renderDropdown(): void {
    this.dropdownEl.innerHTML = "";
    for (let i = 0; i < this.suggestions.length && i < 8; i++) {
      const s = this.suggestions[i];
      const row = document.createElement("div");
      row.className = "suggest-item" + (i === this.selectedIndex ? " selected" : "");

      const icon = document.createElement("span");
      icon.className = "suggest-icon";
      icon.textContent = s.kind === "directory" ? "📁" : s.kind === "file" ? "📄" : s.kind === "command" ? "/" : "↩";
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "suggest-label";
      label.textContent = s.text;
      row.appendChild(label);

      const kind = document.createElement("span");
      kind.className = "suggest-kind";
      kind.textContent = s.kind;
      row.appendChild(kind);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.currentSuggestion = s.text;
      });

      this.dropdownEl.appendChild(row);
    }
  }

  // ── Path completion ───────────────────────────────────────────────────

  private checkPathCompletion(input: string): void {
    // Extract the current word (after the last space)
    const parts = input.split(/\s+/);
    const currentWord = parts[parts.length - 1] || "";
    const command = parts[0] || "";

    // Only complete paths for known path commands, or if word looks like a path
    const isPathCmd = PATH_COMMANDS.has(command);
    const looksLikePath = currentWord.startsWith("/") || currentWord.startsWith("./") ||
                          currentWord.startsWith("../") || currentWord.startsWith("~");

    if (!isPathCmd && !looksLikePath) return;
    if (!currentWord) return;

    // Debounce path queries to avoid hammering the filesystem
    if (this.pendingPathQuery) clearTimeout(this.pendingPathQuery);
    this.pendingPathQuery = setTimeout(() => {
      this.fetchPathSuggestions(input, currentWord).catch(() => {});
    }, 100);
  }

  private async fetchPathSuggestions(fullInput: string, pathFragment: string): Promise<void> {
    // Split into directory and partial name
    const lastSlash = pathFragment.lastIndexOf("/");
    let dir: string;
    let partial: string;

    if (lastSlash >= 0) {
      dir = pathFragment.slice(0, lastSlash + 1) || "/";
      partial = pathFragment.slice(lastSlash + 1).toLowerCase();
    } else {
      dir = ".";
      partial = pathFragment.toLowerCase();
    }

    // Expand ~ — use agent_run_command to resolve
    if (dir.startsWith("~")) {
      try {
        const home = await invoke<string>("agent_run_command", { command: "echo $HOME" });
        dir = home.trim() + dir.slice(1);
      } catch { return; }
    }

    try {
      const entries = await invoke<string>("agent_list_directory", { path: dir, recursive: false });
      const lines = entries.split("\n").filter((l) => l.trim());

      // Filter by partial match
      const matches = lines
        .filter((name) => name.toLowerCase().startsWith(partial) && name.toLowerCase() !== partial)
        .slice(0, 8);

      if (matches.length === 0) return;

      // Build full suggestions
      const prefix = fullInput.slice(0, fullInput.length - (partial.length || 0));
      const pathSuggestions: Suggestion[] = [];

      for (const name of matches) {
        const isDir = name.endsWith("/");
        pathSuggestions.push({
          text: prefix + name,
          kind: isDir ? "directory" : "file",
        });
      }

      // Merge path suggestions with existing ones (path suggestions first)
      const existing = this.suggestions.filter((s) => s.kind !== "file" && s.kind !== "directory");
      this.suggestions = [...pathSuggestions, ...existing];

      // Update display
      if (this.suggestions.length > 0) {
        this.currentSuggestion = this.suggestions[0].text;
        this.showGhost(this.suggestions[0].text.slice(fullInput.length));
        if (this.suggestions.length > 1) {
          this.showDropdown(fullInput);
        }
      }
    } catch {
      // Directory listing failed — no path suggestions
    }
  }

  // ── Pixel positioning ─────────────────────────────────────────────────

  private getCursorPixelPos(): { x: number; y: number; lineHeight: number } | null {
    const { row, col } = this.grid.getCursorPos();
    const rowEl = this.grid.getRowElement(row);
    if (!rowEl) return null;

    const cursorCell = rowEl.children[col] as HTMLElement | undefined;
    if (!cursorCell) return null;

    const gridEl = this.grid.getGridElement();
    const gridRect = gridEl.getBoundingClientRect();
    const cellRect = cursorCell.getBoundingClientRect();

    return {
      x: cellRect.right - gridRect.left,
      y: cellRect.top - gridRect.top,
      lineHeight: cellRect.height,
    };
  }
}
