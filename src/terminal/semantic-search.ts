// semantic-search.ts — Ctrl+R history search with fuzzy matching
// Falls back to substring search (Ollama embedding support is future enhancement).

import { historyDb, type HistoryEntry } from "./history-db";

export class SemanticSearch {
  private overlayEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private results: HistoryEntry[] = [];
  private highlightIdx = 0;
  private _isOpen = false;
  private container: HTMLElement;
  private onInsert: (command: string) => void;

  constructor(container: HTMLElement, onInsert: (command: string) => void) {
    this.container = container;
    this.onInsert = onInsert;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) { this.inputEl?.focus(); return; }

    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "semantic-search-overlay";

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "semantic-search-input";
    this.inputEl.placeholder = "Search history...";
    this.inputEl.setAttribute("aria-label", "Search command history");

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "semantic-search-results";
    this.resultsEl.setAttribute("role", "listbox");

    this.overlayEl.appendChild(this.inputEl);
    this.overlayEl.appendChild(this.resultsEl);
    this.container.appendChild(this.overlayEl);
    this._isOpen = true;

    this.inputEl.addEventListener("input", () => {
      this.search(this.inputEl!.value);
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (!this._isOpen) return;
      e.stopPropagation();

      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.highlightIdx = Math.min(this.highlightIdx + 1, this.results.length - 1);
        this.renderResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.highlightIdx = Math.max(this.highlightIdx - 1, 0);
        this.renderResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (this.results[this.highlightIdx]) {
          this.onInsert(this.results[this.highlightIdx].command);
          this.close();
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);

    // Show recent history immediately
    this.results = historyDb.getRecent(20).reverse();
    this.highlightIdx = 0;
    this.renderResults();

    setTimeout(() => this.inputEl?.focus(), 0);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.overlayEl?.remove();
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.overlayEl = null;
    this.inputEl = null;
    this.resultsEl = null;
  }

  private search(query: string): void {
    if (!query.trim()) {
      this.results = historyDb.getRecent(20).reverse();
    } else {
      this.results = historyDb.findBySubstring(query);
    }
    this.highlightIdx = 0;
    this.renderResults();
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = "";

    for (let i = 0; i < this.results.length; i++) {
      const entry = this.results[i];
      const item = document.createElement("div");
      item.className = "semantic-search-item" + (i === this.highlightIdx ? " highlighted" : "");
      item.setAttribute("role", "option");

      const cmd = document.createElement("div");
      cmd.className = "semantic-search-item-cmd";
      cmd.textContent = entry.command;

      const meta = document.createElement("div");
      meta.className = "semantic-search-item-meta";
      const cwd = entry.cwd.replace(/^\/Users\/[^/]+/, "~");
      const time = new Date(entry.timestamp).toLocaleString();
      meta.textContent = `${cwd} • ${time}`;

      item.appendChild(cmd);
      item.appendChild(meta);
      item.addEventListener("click", () => {
        this.onInsert(entry.command);
        this.close();
      });
      this.resultsEl!.appendChild(item);
    }

    const highlighted = this.resultsEl.querySelector(".highlighted");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }
}
