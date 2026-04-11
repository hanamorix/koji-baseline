// tab-manager.ts — Tab bar UI, tab creation/closing/switching

import { TabSession } from "./tab-session";
import { playLinkedAnimation } from "./linked-art";

export class TabManager {
  private tabs: Map<string, TabSession> = new Map();
  private tabOrder: string[] = [];
  private activeTabId = "";
  private parentContainer: HTMLElement;
  private tabsContainerEl: HTMLElement;
  private _renaming = false;

  constructor(parentContainer: HTMLElement) {
    this.parentContainer = parentContainer;
    this.tabsContainerEl = document.getElementById("tabbar-tabs")!;

    document.getElementById("tabbar-new")!.addEventListener("click", () => {
      this.createTab();
    });
  }

  getActive(): TabSession | undefined {
    return this.tabs.get(this.activeTabId);
  }

  getAllTabs(): TabSession[] {
    return this.tabOrder.map((id) => this.tabs.get(id)!).filter(Boolean);
  }

  getTabCount(): number { return this.tabs.size; }

  async createTab(): Promise<TabSession> {
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const session = new TabSession(id, this.parentContainer);
    this.tabs.set(id, session);
    this.tabOrder.push(id);

    const current = this.getActive();
    if (current) current.deactivate();

    this.activeTabId = id;
    session.activate();
    await session.start();

    playLinkedAnimation(session.containerEl);
    this.renderTabBar();
    return session;
  }

  async closeTab(id: string): Promise<void> {
    const session = this.tabs.get(id);
    if (!session) return;

    // Remember position before removing
    const closedIdx = this.tabOrder.indexOf(id);

    await session.close();
    this.tabs.delete(id);
    this.tabOrder = this.tabOrder.filter((t) => t !== id);

    if (this.activeTabId === id) {
      if (this.tabOrder.length > 0) {
        // Switch to nearest neighbor (prefer the one before, or the one that slid into this position)
        const nearestIdx = Math.min(Math.max(0, closedIdx - 1), this.tabOrder.length - 1);
        this.switchTo(this.tabOrder[nearestIdx]);
      } else {
        // Last tab closed — create a new one
        await this.createTab();
        return;
      }
    }
    this.renderTabBar();
  }

  async closeActiveTab(): Promise<void> {
    if (this.activeTabId) await this.closeTab(this.activeTabId);
  }

  switchTo(id: string): void {
    if (id === this.activeTabId) return;
    const session = this.tabs.get(id);
    if (!session) return;

    const current = this.getActive();
    if (current) current.deactivate();

    this.activeTabId = id;
    session.activate();
    this.renderTabBar();
  }

  nextTab(): void {
    const idx = this.tabOrder.indexOf(this.activeTabId);
    if (idx < 0) return;
    this.switchTo(this.tabOrder[(idx + 1) % this.tabOrder.length]);
  }

  prevTab(): void {
    const idx = this.tabOrder.indexOf(this.activeTabId);
    if (idx < 0) return;
    this.switchTo(this.tabOrder[(idx - 1 + this.tabOrder.length) % this.tabOrder.length]);
  }

  switchToNumber(n: number): void {
    if (n >= 1 && n <= this.tabOrder.length) this.switchTo(this.tabOrder[n - 1]);
  }

  setTabName(id: string, name: string): void {
    const session = this.tabs.get(id);
    if (session) { session.name = name; this.renderTabBar(); }
  }

  private renderTabBar(): void {
    if (this._renaming) return; // Don't destroy the rename input
    this.tabsContainerEl.innerHTML = "";
    for (const id of this.tabOrder) {
      const session = this.tabs.get(id);
      if (!session) continue;

      const tab = document.createElement("div");
      tab.className = "tabbar-tab" + (id === this.activeTabId ? " active" : "");

      const label = document.createElement("span");
      label.className = "tabbar-tab-label";
      label.textContent = session.name;
      label.addEventListener("dblclick", (e) => { e.stopPropagation(); this.startRename(id, label); });

      const close = document.createElement("span");
      close.className = "tabbar-tab-close";
      close.textContent = "\u00d7";
      close.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(id); });

      tab.appendChild(label);
      tab.appendChild(close);
      tab.addEventListener("click", () => this.switchTo(id));
      this.tabsContainerEl.appendChild(tab);
    }
  }

  private startRename(id: string, labelEl: HTMLSpanElement): void {
    const session = this.tabs.get(id);
    if (!session) return;

    this._renaming = true;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.style.cssText = "background:transparent;border:1px solid var(--koji-dim);color:var(--koji-bright);font:inherit;font-size:inherit;padding:0 2px;width:100px;outline:none;";

    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
      this._renaming = false;
      session.name = input.value.trim() || session.name;
      this.renderTabBar(); // Rebuild the tab bar with the new name
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = session.name; input.blur(); }
      e.stopPropagation();
    });
  }
}
