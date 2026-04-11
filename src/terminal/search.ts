// search.ts — Floating search bar for terminal scrollback

import type { DOMGrid } from "./dom-grid";

interface SearchMatch {
  rowEl: HTMLElement;
  colStart: number;
  colEnd: number;
}

export class TerminalSearch {
  private grid: DOMGrid;
  private container: HTMLElement;
  private barEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private countEl: HTMLSpanElement | null = null;
  private matches: SearchMatch[] = [];
  private currentMatchIdx = -1;
  private highlightedSpans: HTMLElement[] = [];
  private _isOpen = false;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(container: HTMLElement, grid: DOMGrid) {
    this.container = container;
    this.grid = grid;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) {
      this.inputEl?.focus();
      this.inputEl?.select();
      return;
    }

    this.barEl = document.createElement("div");
    this.barEl.className = "search-bar";
    this.barEl.setAttribute("role", "search");
    this.barEl.setAttribute("aria-label", "Search terminal");

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.placeholder = "Search...";
    this.inputEl.setAttribute("aria-label", "Search term");

    this.countEl = document.createElement("span");
    this.countEl.className = "search-count";
    this.countEl.setAttribute("aria-live", "polite");

    const prevBtn = document.createElement("button");
    prevBtn.textContent = "\u25B2";
    prevBtn.setAttribute("aria-label", "Previous match");
    prevBtn.addEventListener("click", () => this.navigateMatch(-1));

    const nextBtn = document.createElement("button");
    nextBtn.textContent = "\u25BC";
    nextBtn.setAttribute("aria-label", "Next match");
    nextBtn.addEventListener("click", () => this.navigateMatch(1));

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u2715";
    closeBtn.setAttribute("aria-label", "Close search");
    closeBtn.addEventListener("click", () => this.close());

    this.barEl.appendChild(this.inputEl);
    this.barEl.appendChild(this.countEl);
    this.barEl.appendChild(prevBtn);
    this.barEl.appendChild(nextBtn);
    this.barEl.appendChild(closeBtn);
    this.container.appendChild(this.barEl);
    this._isOpen = true;

    let searchDebounce: ReturnType<typeof setTimeout> | null = null;
    this.inputEl.addEventListener("input", () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => this.performSearch(), 150);
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (!this._isOpen) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.navigateMatch(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);
    setTimeout(() => this.inputEl?.focus(), 0);
  }

  close(): void {
    if (!this._isOpen) return;
    this.clearHighlights();
    this.barEl?.remove();
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.barEl = null;
    this.inputEl = null;
    this.countEl = null;
    this.matches = [];
    this.currentMatchIdx = -1;
    this._isOpen = false;
  }

  private performSearch(): void {
    this.clearHighlights();
    const query = this.inputEl?.value.toLowerCase() ?? "";
    if (!query) {
      this.matches = [];
      this.currentMatchIdx = -1;
      if (this.countEl) this.countEl.textContent = "";
      return;
    }

    this.matches = [];
    const scrollEl = this.grid.getScrollElement();
    const rows = scrollEl.querySelectorAll(".grid-row");

    rows.forEach((rowEl) => {
      const text = rowEl.textContent?.toLowerCase() ?? "";
      let pos = 0;
      let idx: number;
      while ((idx = text.indexOf(query, pos)) !== -1) {
        this.matches.push({ rowEl: rowEl as HTMLElement, colStart: idx, colEnd: idx + query.length });
        pos = idx + 1;
      }
    });

    for (const m of this.matches) this.applyHighlight(m, false);

    if (this.matches.length > 0) {
      this.currentMatchIdx = 0;
      this.applyHighlight(this.matches[0], true);
      this.matches[0].rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    this.updateCount();
  }

  private navigateMatch(delta: number): void {
    if (this.matches.length === 0) return;
    if (this.currentMatchIdx >= 0) this.applyHighlight(this.matches[this.currentMatchIdx], false);
    this.currentMatchIdx = (this.currentMatchIdx + delta + this.matches.length) % this.matches.length;
    this.applyHighlight(this.matches[this.currentMatchIdx], true);
    this.matches[this.currentMatchIdx].rowEl.scrollIntoView({ block: "center", behavior: "smooth" });
    this.updateCount();
  }

  private applyHighlight(match: SearchMatch, active: boolean): void {
    const cells = match.rowEl.querySelectorAll(".cell");
    for (let c = match.colStart; c < match.colEnd && c < cells.length; c++) {
      const cell = cells[c] as HTMLElement;
      cell.classList.remove("search-match", "search-match-active");
      cell.classList.add(active ? "search-match-active" : "search-match");
      this.highlightedSpans.push(cell);
    }
  }

  private clearHighlights(): void {
    for (const s of this.highlightedSpans) s.classList.remove("search-match", "search-match-active");
    this.highlightedSpans = [];
  }

  private updateCount(): void {
    if (!this.countEl) return;
    this.countEl.textContent = this.matches.length === 0
      ? "No matches"
      : `${this.currentMatchIdx + 1} of ${this.matches.length}`;
  }
}
