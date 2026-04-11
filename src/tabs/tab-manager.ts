// tab-manager.ts — Tab bar UI, tab creation/closing/switching
// Each tab owns a PaneLayout (binary tree of TabSessions).

import { TabSession } from "./tab-session";
import { PaneLayout } from "../panes/pane-layout";
import { playLinkedAnimation } from "./linked-art";
import { enableTabDrag } from "./tab-drag";

export class TabManager {
  private layouts: Map<string, PaneLayout> = new Map();
  private tabOrder: string[] = [];
  private activeTabId = "";
  private parentContainer: HTMLElement;
  private tabsContainerEl: HTMLElement;
  private _renaming = false;

  constructor(parentContainer: HTMLElement) {
    this.parentContainer = parentContainer;
    this.tabsContainerEl = document.getElementById("tabbar-tabs")!;

    document.getElementById("tabbar-new")!.addEventListener("click", () => {
      this.createTab().catch((err) => console.error("New tab failed:", err));
    });

    enableTabDrag(this.tabsContainerEl, (fromIdx, toIdx) => {
      const [moved] = this.tabOrder.splice(fromIdx, 1);
      this.tabOrder.splice(toIdx, 0, moved);
      this.renderTabBar();
    });
  }

  /** Get the active pane's TabSession (from the active tab's layout) */
  getActive(): TabSession | undefined {
    const layout = this.layouts.get(this.activeTabId);
    return layout?.getActiveSession();
  }

  /** Get ALL sessions across ALL tabs (for theme/font propagation) */
  getAllTabs(): TabSession[] {
    const all: TabSession[] = [];
    for (const layout of this.layouts.values()) {
      all.push(...layout.getAllSessions());
    }
    return all;
  }

  getTabCount(): number { return this.layouts.size; }

  async createTab(): Promise<TabSession> {
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Get CWD from currently active pane before switching
    const currentCwd = this.getActive()?.cwd || "";

    // Deactivate current tab's layout
    const currentLayout = this.layouts.get(this.activeTabId);
    if (currentLayout) {
      for (const s of currentLayout.getAllSessions()) s.deactivate();
      // Hide the current tab's DOM
      const currentRoot = this.parentContainer.querySelector(`[data-layout-id="${this.activeTabId}"]`) as HTMLElement;
      if (currentRoot) currentRoot.style.display = "none";
    }

    // Create tab wrapper
    const tabWrapper = document.createElement("div");
    tabWrapper.className = "tab-layout-wrapper";
    tabWrapper.dataset.layoutId = tabId;
    tabWrapper.style.cssText = "position:absolute;inset:0;";
    this.parentContainer.appendChild(tabWrapper);

    // Create initial session
    const session = new TabSession(`${tabId}-pane-0`, tabWrapper);
    const layout = new PaneLayout(tabWrapper, session);

    this.layouts.set(tabId, layout);
    this.tabOrder.push(tabId);
    this.activeTabId = tabId;

    // Render tab bar immediately
    this.renderTabBar();

    // Wire CWD + session-closed callbacks
    session.onSessionClosed(() => {
      session.name = `${session.name} [exited]`;
      this.renderTabBar();
    });
    session.onCwdChanged((path) => {
      const basename = path.split("/").pop() || path;
      session.name = basename;
      this.renderTabBar();
      if (session.active) {
        const cwdEl = document.getElementById("cwd-path");
        if (cwdEl) cwdEl.textContent = path.replace(/^\/Users\/[^/]+/, "~");
      }
      this.updateProxyPath();
    });

    try {
      session.activate();
      await session.start(currentCwd || undefined);
      playLinkedAnimation(session.containerEl);
    } catch (err) {
      console.error(`Failed to start tab ${tabId}:`, err);
      this.layouts.delete(tabId);
      this.tabOrder = this.tabOrder.filter((t) => t !== tabId);
      tabWrapper.remove();
      if (this.tabOrder.length > 0) {
        this.switchTo(this.tabOrder[this.tabOrder.length - 1]);
      } else {
        this.activeTabId = "";
      }
      this.renderTabBar();
      throw err;
    }

    return session;
  }

  async closeTab(tabId: string): Promise<void> {
    const layout = this.layouts.get(tabId);
    if (!layout) return;

    const closedIdx = this.tabOrder.indexOf(tabId);

    layout.destroy();
    this.layouts.delete(tabId);
    this.tabOrder = this.tabOrder.filter((t) => t !== tabId);

    // Remove DOM
    const wrapper = this.parentContainer.querySelector(`[data-layout-id="${tabId}"]`);
    wrapper?.remove();

    if (this.activeTabId === tabId) {
      if (this.tabOrder.length > 0) {
        const nearestIdx = Math.min(Math.max(0, closedIdx - 1), this.tabOrder.length - 1);
        this.switchTo(this.tabOrder[nearestIdx]);
      } else {
        await this.createTab();
        return;
      }
    }
    this.renderTabBar();
  }

  async closeActiveTab(): Promise<void> {
    if (this.activeTabId) await this.closeTab(this.activeTabId);
  }

  switchTo(tabId: string): void {
    if (tabId === this.activeTabId) return;
    const layout = this.layouts.get(tabId);
    if (!layout) return;

    // Hide current
    const currentLayout = this.layouts.get(this.activeTabId);
    if (currentLayout) {
      for (const s of currentLayout.getAllSessions()) s.deactivate();
      const currentRoot = this.parentContainer.querySelector(`[data-layout-id="${this.activeTabId}"]`) as HTMLElement;
      if (currentRoot) currentRoot.style.display = "none";
    }

    // Show new
    this.activeTabId = tabId;
    const newRoot = this.parentContainer.querySelector(`[data-layout-id="${tabId}"]`) as HTMLElement;
    if (newRoot) newRoot.style.display = "";
    for (const s of layout.getAllSessions()) s.activate();
    layout.resizeAll();

    this.renderTabBar();
    this.updateProxyPath();
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

  setTabName(_tabId: string, _name: string): void {
    // Tab name comes from the first pane's CWD
    this.renderTabBar();
  }

  // ── Pane operations ────────────────────────────────────────────────────────

  async splitActivePane(direction: "horizontal" | "vertical"): Promise<void> {
    const layout = this.layouts.get(this.activeTabId);
    if (!layout) return;

    const currentCwd = this.getActive()?.cwd || "";
    const tabId = this.activeTabId;

    const newSession = await layout.splitActive(direction, async (parentEl) => {
      const paneId = `${tabId}-pane-${Date.now()}`;
      const session = new TabSession(paneId, parentEl);

      session.onSessionClosed(() => {
        session.name = `${session.name} [exited]`;
        this.renderTabBar();
      });
      session.onCwdChanged((path) => {
        const basename = path.split("/").pop() || path;
        session.name = basename;
        this.renderTabBar();
        this.updateProxyPath();
      });

      session.activate();
      await session.start(currentCwd || undefined);
      return session;
    });

    if (newSession) {
      playLinkedAnimation(newSession.containerEl);
    }
  }

  closeActivePane(): void {
    const layout = this.layouts.get(this.activeTabId);
    if (!layout) return;

    const active = this.getActive();
    if (!active) return;

    const result = layout.closePane(active.id);
    if (result.closedAll) {
      this.closeTab(this.activeTabId);
    }
  }

  focusPaneDirection(dir: "left" | "right" | "up" | "down"): void {
    const layout = this.layouts.get(this.activeTabId);
    layout?.focusDirection(dir);
  }

  togglePaneZoom(): void {
    const layout = this.layouts.get(this.activeTabId);
    layout?.toggleZoom();
  }

  // ── Tab bar rendering ──────────────────────────────────────────────────────

  private renderTabBar(): void {
    if (this._renaming) return;
    this.tabsContainerEl.innerHTML = "";
    for (const tabId of this.tabOrder) {
      const layout = this.layouts.get(tabId);
      if (!layout) continue;

      const firstSession = layout.getAllSessions()[0];
      const name = firstSession?.name || "terminal";

      const isActive = tabId === this.activeTabId;
      const tab = document.createElement("div");
      tab.className = "tabbar-tab" + (isActive ? " active" : "");
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", isActive ? "true" : "false");
      tab.setAttribute("aria-label", name);

      const label = document.createElement("span");
      label.className = "tabbar-tab-label";
      label.textContent = name;
      label.addEventListener("dblclick", (e) => { e.stopPropagation(); this.startRename(tabId, label, firstSession); });

      const paneCount = layout.getPaneCount();
      if (paneCount > 1) {
        const badge = document.createElement("span");
        badge.className = "tabbar-pane-count";
        badge.textContent = `${paneCount}`;
        label.appendChild(badge);
      }

      const close = document.createElement("span");
      close.className = "tabbar-tab-close";
      close.textContent = "\u00d7";
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", `Close ${name}`);
      close.addEventListener("click", (e) => { e.stopPropagation(); this.closeTab(tabId); });

      tab.appendChild(label);
      tab.appendChild(close);
      tab.addEventListener("click", () => this.switchTo(tabId));
      this.tabsContainerEl.appendChild(tab);
    }
  }

  private startRename(_tabId: string, labelEl: HTMLSpanElement, session: TabSession | undefined): void {
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
      this.renderTabBar();
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = session.name; input.blur(); }
      e.stopPropagation();
    });
  }

  private updateProxyPath(): void {
    const el = document.getElementById("proxy-path");
    if (!el) return;
    const active = this.getActive();
    if (active?.cwd) {
      el.textContent = active.cwd.replace(/^\/Users\/[^/]+/, "~");
      el.title = active.cwd;
    }
  }
}
