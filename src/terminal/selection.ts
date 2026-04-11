// selection.ts — Selection management, copy-on-select, smart Cmd+C, bracketed paste

const BRACKET_OPEN = "\x1b[200~";
const BRACKET_CLOSE = "\x1b[201~";

export type WriteFn = (data: number[]) => Promise<void>;

export class SelectionManager {
  private gridEl: HTMLElement;
  private copyOnSelect: boolean;
  private writeFn: WriteFn;

  constructor(gridEl: HTMLElement, writeFn: WriteFn, copyOnSelect = true) {
    this.gridEl = gridEl;
    this.writeFn = writeFn;
    this.copyOnSelect = copyOnSelect;
    this.setupCopyOnSelect();
    this.setupMiddleClick();
  }

  setCopyOnSelect(enabled: boolean): void {
    this.copyOnSelect = enabled;
  }

  getSelectedText(): string {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return "";
    const range = sel.getRangeAt(0);
    if (!this.gridEl.contains(range.commonAncestorContainer)) return "";
    return sel.toString();
  }

  async handleCopy(): Promise<boolean> {
    const text = this.getSelectedText();
    if (text) {
      await navigator.clipboard.writeText(text);
      window.getSelection()?.removeAllRanges();
      return true;
    }
    return false;
  }

  async handlePaste(): Promise<void> {
    const text = await navigator.clipboard.readText();
    if (!text) return;

    // Safety limit: 256KB. Larger pastes risk PTY buffer overflow or frozen UI.
    const MAX_PASTE = 256 * 1024;
    const clipped = text.length > MAX_PASTE ? text.slice(0, MAX_PASTE) : text;

    const bracketed = BRACKET_OPEN + clipped + BRACKET_CLOSE;
    const data = Array.from(new TextEncoder().encode(bracketed));
    await this.writeFn(data);
  }

  private setupCopyOnSelect(): void {
    this.gridEl.addEventListener("mouseup", async () => {
      if (!this.copyOnSelect) return;
      await new Promise((r) => setTimeout(r, 10));
      const text = this.getSelectedText();
      if (text) {
        await navigator.clipboard.writeText(text);
      }
    });
  }

  private setupMiddleClick(): void {
    this.gridEl.addEventListener("mousedown", async (e) => {
      if (e.button === 1) {
        e.preventDefault();
        await this.handlePaste();
      }
    });
  }
}
