// visor.ts — Quick terminal visor panel (dropdown from top)
// Slides down like a visor. One session, lazy-created on first toggle.

import { TabSession } from "../tabs/tab-session";

export class Visor {
  private panelEl: HTMLElement;
  private session: TabSession | null = null;
  private _isOpen = false;

  constructor(heightPercent = 40) {
    this.panelEl = document.getElementById("visor-panel")!;
    if (!this.panelEl) {
      this.panelEl = document.createElement("div");
      this.panelEl.id = "visor-panel";
      this.panelEl.className = "visor-panel";
      document.getElementById("app")!.appendChild(this.panelEl);
    }
    this.panelEl.style.height = `${heightPercent}vh`;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  async toggle(): Promise<void> {
    if (this._isOpen) {
      this.hide();
    } else {
      await this.show();
    }
  }

  private async show(): Promise<void> {
    this._isOpen = true;
    this.panelEl.classList.add("visor-open");

    if (!this.session) {
      // Create session on first open — lazy init keeps boot fast
      this.session = new TabSession("visor-session", this.panelEl);
      this.session.activate();
      await this.session.start();
    } else {
      this.session.activate();
      requestAnimationFrame(() => {
        const { rows, cols } = this.session!.grid.measureGrid();
        this.session!.resize(rows, cols);
      });
    }
  }

  hide(): void {
    this._isOpen = false;
    this.panelEl.classList.remove("visor-open");
    this.session?.deactivate();
  }

  getSession(): TabSession | null {
    return this.session;
  }
}
