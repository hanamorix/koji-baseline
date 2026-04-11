// overlay.ts — DOM overlay manager
// Renders messages, LLM responses (with markdown), and menus over the terminal grid.

import { renderMarkdown } from "../agent/markdown";

export class TerminalOverlay {
  private container: HTMLElement;
  private currentElement: HTMLElement | null = null;
  private _isActive = false;

  constructor() {
    const el = document.getElementById("terminal-overlay");
    if (!el) throw new Error("#terminal-overlay not found");
    this.container = el;
  }

  get isActive(): boolean {
    return this._isActive;
  }

  /** Show a text message (command output or LLM response). */
  showMessage(text: string, isError = false): void {
    this.dismiss();
    const div = document.createElement("div");
    div.className = "overlay-message" + (isError ? " error" : "");
    div.textContent = text;
    this.container.appendChild(div);
    this.currentElement = div;
    this.activate();
  }

  /** Update streaming text in-place (for LLM responses). */
  updateStreaming(text: string, done: boolean): void {
    if (!this.currentElement || !this.currentElement.classList.contains("streaming")) {
      this.dismiss();
      const div = document.createElement("div");
      div.className = "overlay-message streaming";
      this.container.appendChild(div);
      this.currentElement = div;
      this.activate();
    }
    if (done) {
      // Render final text as markdown
      this.currentElement!.innerHTML = renderMarkdown(text);
      this.currentElement!.classList.remove("streaming");
      this.currentElement!.classList.add("chat-body"); // Apply markdown styles
    } else {
      // While streaming, show plain text (faster, no reflow)
      this.currentElement!.textContent = text;
    }
  }

  /** Clear all overlay content. */
  dismiss(): void {
    this.container.innerHTML = "";
    this.currentElement = null;
    this.deactivate();
  }

  /** Dismiss after a timeout — useful for transient success messages. */
  dismissAfter(ms: number): void {
    setTimeout(() => {
      if (this._isActive) this.dismiss();
    }, ms);
  }

  /** Mount a raw DOM element into the overlay (used by menus, agent pane). */
  mount(element: HTMLElement): void {
    this.dismiss();
    this.container.appendChild(element);
    this.currentElement = element;
    this.activate();
  }

  private activate(): void {
    this._isActive = true;
    this.container.classList.add("active");
  }

  private deactivate(): void {
    this._isActive = false;
    this.container.classList.remove("active");
  }
}

/** Singleton overlay instance. */
export const overlay = new TerminalOverlay();
