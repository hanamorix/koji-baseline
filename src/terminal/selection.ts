// selection.ts — Selection management, copy-on-select, smart Cmd+C, bracketed paste

import { invoke } from "@tauri-apps/api/core";

const BRACKET_OPEN = "\x1b[200~";
const BRACKET_CLOSE = "\x1b[201~";

export class SelectionManager {
  private gridEl: HTMLElement;
  private copyOnSelect: boolean;

  constructor(gridEl: HTMLElement, copyOnSelect = true) {
    this.gridEl = gridEl;
    this.copyOnSelect = copyOnSelect;
    this.setupCopyOnSelect();
    this.setupMiddleClick();
  }

  setCopyOnSelect(enabled: boolean): void {
    this.copyOnSelect = enabled;
  }

  /** Get currently selected text within the grid, or empty string if none. */
  getSelectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return "";

    // Only return text if selection is within our grid
    const range = sel.getRangeAt(0);
    if (!this.gridEl.contains(range.commonAncestorContainer)) return "";

    return sel.toString();
  }

  /** Smart Cmd+C: copy selection if present, otherwise send SIGINT (^C) to PTY. */
  async handleCopy(): Promise<boolean> {
    const text = this.getSelectedText();
    if (text) {
      await navigator.clipboard.writeText(text);
      // Clear selection after copy
      window.getSelection()?.removeAllRanges();
      return true; // copied
    }
    return false; // no selection — caller should send ^C
  }

  /** Paste from clipboard with bracketed paste escapes. */
  async handlePaste(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (!text) return;

    const bracketed = BRACKET_OPEN + text + BRACKET_CLOSE;
    const encoder = new TextEncoder();
    const data = Array.from(encoder.encode(bracketed));
    await invoke("write_to_pty", { data });
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private setupCopyOnSelect(): void {
    this.gridEl.addEventListener("mouseup", async () => {
      if (!this.copyOnSelect) return;
      // Small delay to let browser finalize selection
      await new Promise((r) => setTimeout(r, 10));
      const text = this.getSelectedText();
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    });
  }

  private setupMiddleClick(): void {
    this.gridEl.addEventListener("mousedown", async (e) => {
      if (e.button === 1) { // middle click
        e.preventDefault();
        await this.handlePaste();
      }
    });
  }
}
