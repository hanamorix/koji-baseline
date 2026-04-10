// autocomplete.ts — Floating ghost text + suggestion dropdown
// Ghost text floats at the cursor. Dropdown shows files, dirs, history, commands.

import { invoke } from "@tauri-apps/api/core";
import type { DOMGrid } from "./dom-grid";

const SLASH_COMMANDS = [
  "/help", "/version", "/theme", "/font", "/llm", "/llm models",
  "/llm recommend", "/llm autorun off", "/llm autorun safe",
  "/llm autorun full", "/agent", "/exit",
];

const PATH_COMMANDS = new Set([
  "cd", "ls", "cat", "less", "more", "head", "tail", "vim", "nvim",
  "nano", "code", "open", "rm", "cp", "mv", "mkdir", "touch",
  "chmod", "chown", "find", "grep", "rg", "bat", "source", ".",
]);

interface Suggestion {
  text: string;
  display: string;
  kind: "history" | "command" | "file" | "directory";
}

export class Autocomplete {
  private grid: DOMGrid;
  private ghostEl: HTMLDivElement;
  private dropdownEl: HTMLDivElement;
  private currentSuggestion = "";
  private suggestions: Suggestion[] = [];
  private selectedIndex = 0;
  private shellHistory: string[] = [];
  private visible = false;
  private dropdownVisible = false;
  private lastInput = "";
  private pathQueryId = 0; // Increment to invalidate stale async results

  constructor(container: HTMLElement, grid: DOMGrid) {
    this.grid = grid;

    this.ghostEl = document.createElement("div");
    this.ghostEl.className = "ghost-float";
    container.appendChild(this.ghostEl);

    this.dropdownEl = document.createElement("div");
    this.dropdownEl.className = "suggest-dropdown";
    container.appendChild(this.dropdownEl);
  }

  addToHistory(cmd: string): void {
    if (!cmd.trim()) return;
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Call on every keystroke. Builds suggestions and shows ghost/dropdown. */
  update(input: string): void {
    this.lastInput = input;

    if (!input) {
      this.hide();
      return;
    }

    // Build synchronous suggestions first
    this.suggestions = [];
    this.selectedIndex = 0;

    if (input.startsWith("/")) {
      const lower = input.toLowerCase();
      for (const cmd of SLASH_COMMANDS) {
        if (cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) {
          this.suggestions.push({ text: cmd, display: cmd, kind: "command" });
        }
      }
    }

    // Shell history (all inputs, not just path commands)
    for (let i = this.shellHistory.length - 1; i >= 0; i--) {
      const h = this.shellHistory[i];
      if (h.startsWith(input) && h !== input) {
        // Avoid duplicates with slash command suggestions
        if (!this.suggestions.some((s) => s.text === h)) {
          this.suggestions.push({ text: h, display: h, kind: "history" });
        }
        if (this.suggestions.length >= 8) break;
      }
    }

    this.applyDisplay();

    // Async: check for path completions
    this.maybePathComplete(input);
  }

  /** Navigate dropdown. Returns true if handled. */
  navigate(delta: number): boolean {
    if (!this.dropdownVisible || this.suggestions.length === 0) return false;

    this.selectedIndex += delta;
    if (this.selectedIndex < 0) this.selectedIndex = this.suggestions.length - 1;
    if (this.selectedIndex >= this.suggestions.length) this.selectedIndex = 0;

    this.currentSuggestion = this.suggestions[this.selectedIndex].text;

    // Update ghost to show selected item's completion
    const completion = this.currentSuggestion.slice(this.lastInput.length);
    this.positionGhost(completion);

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
    this.selectedIndex = 0;
    this.pathQueryId++;
  }

  getSuggestion(): string {
    return this.currentSuggestion;
  }

  isDropdownOpen(): boolean {
    return this.dropdownVisible;
  }

  // ── Display ───────────────────────────────────────────────────────────

  private applyDisplay(): void {
    if (this.suggestions.length > 0) {
      this.currentSuggestion = this.suggestions[0].text;
      const completion = this.currentSuggestion.slice(this.lastInput.length);
      this.positionGhost(completion);

      if (this.suggestions.length > 1) {
        this.showDropdown();
      } else {
        this.hideDropdown();
      }
    } else {
      this.currentSuggestion = "";
      this.hideGhost();
      this.hideDropdown();
    }
  }

  // ── Ghost text ────────────────────────────────────────────────────────

  private positionGhost(completion: string): void {
    if (!completion) { this.hideGhost(); return; }

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

  // ── Dropdown ──────────────────────────────────────────────────────────

  private showDropdown(): void {
    const pos = this.getCursorPixelPos();
    if (!pos) { this.hideDropdown(); return; }

    this.dropdownEl.style.left = `${pos.x}px`;
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
    const limit = Math.min(this.suggestions.length, 8);
    for (let i = 0; i < limit; i++) {
      const s = this.suggestions[i];
      const row = document.createElement("div");
      row.className = "suggest-item" + (i === this.selectedIndex ? " selected" : "");

      const icon = document.createElement("span");
      icon.className = "suggest-icon";
      icon.textContent = s.kind === "directory" ? "📁" : s.kind === "file" ? "📄" : s.kind === "command" ? "⌘" : "↩";
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "suggest-label";
      label.textContent = s.display;
      row.appendChild(label);

      const kind = document.createElement("span");
      kind.className = "suggest-kind";
      kind.textContent = s.kind;
      row.appendChild(kind);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.selectedIndex = i;
        this.currentSuggestion = s.text;
      });

      this.dropdownEl.appendChild(row);
    }
  }

  // ── Path completion ───────────────────────────────────────────────────

  private maybePathComplete(input: string): void {
    const parts = input.split(/\s+/);
    if (parts.length < 2) return; // Need at least "command arg"

    const command = parts[0];
    const currentWord = parts[parts.length - 1] || "";

    const isPathCmd = PATH_COMMANDS.has(command);
    const looksLikePath = currentWord.startsWith("/") || currentWord.startsWith("./") ||
                          currentWord.startsWith("../") || currentWord.startsWith("~") ||
                          currentWord.includes("/");

    if (!isPathCmd && !looksLikePath) return;

    // Increment query ID to invalidate any in-flight requests
    const queryId = ++this.pathQueryId;

    // Small delay to avoid hammering FS on fast typing
    setTimeout(() => {
      if (this.pathQueryId !== queryId) return; // Stale
      this.fetchPaths(input, currentWord, queryId).catch(() => {});
    }, 80);
  }

  private async fetchPaths(fullInput: string, pathFragment: string, queryId: number): Promise<void> {
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

    // Expand ~
    if (dir.startsWith("~")) {
      try {
        const home = await invoke<string>("agent_run_command", { command: "echo $HOME" });
        dir = home.trim() + dir.slice(1);
      } catch { return; }
    }

    if (this.pathQueryId !== queryId) return; // Stale

    try {
      const entries = await invoke<string>("agent_list_directory", { path: dir, recursive: false });
      if (this.pathQueryId !== queryId) return; // Stale

      const lines = entries.split("\n").filter((l) => l.trim());
      const matches = lines.filter((name) => {
        const bare = name.replace(/\/$/, "");
        return bare.toLowerCase().startsWith(partial) && bare.toLowerCase() !== partial;
      }).slice(0, 8);

      if (matches.length === 0) return;

      // Build full text for each suggestion
      const inputPrefix = fullInput.slice(0, fullInput.length - pathFragment.length);
      const pathPrefix = lastSlash >= 0 ? pathFragment.slice(0, lastSlash + 1) : "";

      const pathSuggestions: Suggestion[] = matches.map((name) => ({
        text: inputPrefix + pathPrefix + name,
        display: name,
        kind: (name.endsWith("/") ? "directory" : "file") as "directory" | "file",
      }));

      // Merge: path suggestions first, then existing non-path ones
      const existing = this.suggestions.filter((s) => s.kind !== "file" && s.kind !== "directory");
      this.suggestions = [...pathSuggestions, ...existing];
      this.selectedIndex = 0;
      this.applyDisplay();
    } catch {
      // Failed — no path suggestions
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
