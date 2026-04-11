# Batch B: Split Panes + Window Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add split panes with binary tree layout, draggable dividers, keyboard navigation, pane zoom, focus dimming, tab drag reorder, and proxy icon.

**Architecture:** New PaneLayout class manages a binary tree of TabSessions per tab. TabSession is unchanged — it's already a self-contained pane. TabManager delegates pane operations to PaneLayout. Keybindings registered via the existing keybinding system.

**Tech Stack:** TypeScript (DOM flexbox layout, mouse events for dividers/drag)

---

### Task 1: PaneLayout Core — Tree, Split, Close

**Files:**
- Create: `src/panes/pane-layout.ts`

This is the core module. It manages a binary tree of panes within a single tab.

- [ ] **Step 1: Create `src/panes/pane-layout.ts`**

```typescript
// pane-layout.ts — Binary tree layout for split panes within a tab
// Each tab owns one PaneLayout. Leaf nodes contain TabSessions, branch nodes split space.

import { TabSession } from "../tabs/tab-session";

// ─── Tree types ──────────────────────────────────────────────────────────────

export interface PaneLeaf {
  type: "leaf";
  session: TabSession;
  el: HTMLDivElement;
}

export interface PaneBranch {
  type: "branch";
  direction: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  el: HTMLDivElement;
  dividerEl: HTMLDivElement;
}

export type PaneNode = PaneLeaf | PaneBranch;

// ─── PaneLayout ──────────────────────────────────────────────────────────────

export class PaneLayout {
  private root: PaneNode;
  private activeSessionId: string;
  private containerEl: HTMLElement;
  private zoomed = false;
  private preZoomDisplay: Map<HTMLElement, string> = new Map();

  constructor(container: HTMLElement, initialSession: TabSession) {
    this.containerEl = container;
    this.activeSessionId = initialSession.id;

    // Wrap session in a leaf
    const leafEl = document.createElement("div");
    leafEl.className = "pane-leaf active pane-solo";
    leafEl.style.flex = "1";

    // Reparent the session's container into our leaf wrapper
    leafEl.appendChild(initialSession.containerEl);
    container.appendChild(leafEl);

    this.root = { type: "leaf", session: initialSession, el: leafEl };
  }

  getActiveSession(): TabSession | undefined {
    const leaf = this.findLeaf(this.activeSessionId);
    return leaf?.session;
  }

  getAllSessions(): TabSession[] {
    const sessions: TabSession[] = [];
    this.walkLeaves(this.root, (leaf) => sessions.push(leaf.session));
    return sessions;
  }

  getPaneCount(): number {
    let count = 0;
    this.walkLeaves(this.root, () => count++);
    return count;
  }

  // ── Split ──────────────────────────────────────────────────────────────────

  async splitActive(
    direction: "horizontal" | "vertical",
    createSession: (parentContainer: HTMLElement) => Promise<TabSession>,
  ): Promise<TabSession | null> {
    if (this.zoomed) return null; // Can't split while zoomed

    const leaf = this.findLeaf(this.activeSessionId);
    if (!leaf) return null;

    // Create the branch container
    const branchEl = document.createElement("div");
    branchEl.className = `pane-branch ${direction}`;
    branchEl.style.flex = leaf.el.style.flex || "1";

    // First child: the existing session
    const firstEl = document.createElement("div");
    firstEl.className = "pane-leaf active";
    firstEl.style.flex = "0.5";
    firstEl.appendChild(leaf.session.containerEl);

    // Divider
    const dividerEl = document.createElement("div");
    dividerEl.className = `pane-divider ${direction}`;
    this.setupDivider(dividerEl, direction, () => branchEl);

    // Second child: new session (created by caller)
    const secondEl = document.createElement("div");
    secondEl.className = "pane-leaf";
    secondEl.style.flex = "0.5";

    branchEl.appendChild(firstEl);
    branchEl.appendChild(dividerEl);
    branchEl.appendChild(secondEl);

    // Replace the leaf's element in the DOM
    leaf.el.replaceWith(branchEl);

    // Create the new session inside the second leaf
    const newSession = await createSession(secondEl);

    // Build the new branch node
    const firstLeaf: PaneLeaf = { type: "leaf", session: leaf.session, el: firstEl };
    const secondLeaf: PaneLeaf = { type: "leaf", session: newSession, el: secondEl };
    const branch: PaneBranch = {
      type: "branch",
      direction,
      ratio: 0.5,
      first: firstLeaf,
      second: secondLeaf,
      el: branchEl,
      dividerEl,
    };

    // Replace the old leaf in the tree
    this.replaceNode(leaf, branch);

    // Remove solo class from all leaves
    this.updateSoloClass();

    // Focus the new pane
    this.setActiveSession(newSession.id);

    // Resize both panes
    this.resizeAll();

    return newSession;
  }

  // ── Close pane ─────────────────────────────────────────────────────────────

  closePane(sessionId: string): { remaining: number; closedAll: boolean } {
    const leaf = this.findLeaf(sessionId);
    if (!leaf) return { remaining: this.getPaneCount(), closedAll: false };

    // If it's the only pane, signal to close the tab
    if (this.root.type === "leaf") {
      return { remaining: 0, closedAll: true };
    }

    // Find the parent branch and the sibling
    const parent = this.findParent(this.root, leaf);
    if (!parent || parent.type !== "branch") return { remaining: this.getPaneCount(), closedAll: false };

    const sibling = parent.first === leaf ? parent.second : parent.first;

    // Replace the branch with the sibling in the DOM
    sibling.el.style.flex = parent.el.style.flex || "1";
    parent.el.replaceWith(sibling.el);

    // Replace in the tree
    this.replaceNode(parent, sibling);

    // Close the session
    leaf.session.close();

    // If the closed pane was active, focus the sibling
    if (this.activeSessionId === sessionId) {
      const firstLeafInSibling = this.firstLeaf(sibling);
      if (firstLeafInSibling) this.setActiveSession(firstLeafInSibling.session.id);
    }

    this.updateSoloClass();
    this.resizeAll();

    return { remaining: this.getPaneCount(), closedAll: false };
  }

  // ── Focus navigation ───────────────────────────────────────────────────────

  focusDirection(dir: "left" | "right" | "up" | "down"): void {
    const leaves = this.getOrderedLeaves(dir === "left" || dir === "right" ? "horizontal" : "vertical");
    const currentIdx = leaves.findIndex((l) => l.session.id === this.activeSessionId);
    if (currentIdx < 0) return;

    let nextIdx: number;
    if (dir === "right" || dir === "down") {
      nextIdx = (currentIdx + 1) % leaves.length;
    } else {
      nextIdx = (currentIdx - 1 + leaves.length) % leaves.length;
    }

    this.setActiveSession(leaves[nextIdx].session.id);
  }

  // ── Zoom ───────────────────────────────────────────────────────────────────

  toggleZoom(): void {
    if (this.root.type === "leaf") return; // Nothing to zoom

    if (this.zoomed) {
      // Restore
      this.preZoomDisplay.forEach((display, el) => { el.style.display = display; });
      this.preZoomDisplay.clear();
      this.zoomed = false;
    } else {
      // Zoom: hide everything except the active leaf
      this.preZoomDisplay.clear();
      this.walkAll(this.root, (node) => {
        if (node.type === "leaf" && node.session.id !== this.activeSessionId) {
          this.preZoomDisplay.set(node.el, node.el.style.display);
          node.el.style.display = "none";
        }
        if (node.type === "branch") {
          this.preZoomDisplay.set(node.dividerEl, node.dividerEl.style.display);
          node.dividerEl.style.display = "none";
        }
      });
      // Make the active leaf fill the space
      const activeLeaf = this.findLeaf(this.activeSessionId);
      if (activeLeaf) activeLeaf.el.style.flex = "1";
      this.zoomed = true;
    }
    this.resizeAll();
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  resizeAll(): void {
    this.walkLeaves(this.root, (leaf) => {
      if (leaf.el.style.display === "none") return;
      requestAnimationFrame(() => {
        const { rows, cols } = leaf.session.grid.measureGrid();
        leaf.session.resize(rows, cols);
      });
    });
  }

  // ── Destroy ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.walkLeaves(this.root, (leaf) => leaf.session.close());
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private setActiveSession(id: string): void {
    // Remove active class from old
    const oldLeaf = this.findLeaf(this.activeSessionId);
    if (oldLeaf) {
      oldLeaf.el.classList.remove("active");
      oldLeaf.session.setFocused(false);
    }

    this.activeSessionId = id;

    // Add active class to new
    const newLeaf = this.findLeaf(id);
    if (newLeaf) {
      newLeaf.el.classList.add("active");
      newLeaf.session.setFocused(true);
    }
  }

  private findLeaf(sessionId: string, node: PaneNode = this.root): PaneLeaf | null {
    if (node.type === "leaf") return node.session.id === sessionId ? node : null;
    return this.findLeaf(sessionId, node.first) ?? this.findLeaf(sessionId, node.second);
  }

  private findParent(node: PaneNode, target: PaneNode, parent: PaneNode | null = null): PaneBranch | null {
    if (node === target) return parent as PaneBranch | null;
    if (node.type === "leaf") return null;
    return this.findParent(node.first, target, node) ?? this.findParent(node.second, target, node);
  }

  private replaceNode(target: PaneNode, replacement: PaneNode): void {
    if (this.root === target) {
      this.root = replacement;
      return;
    }
    const parent = this.findParent(this.root, target);
    if (parent) {
      if (parent.first === target) parent.first = replacement;
      else if (parent.second === target) parent.second = replacement;
    }
  }

  private firstLeaf(node: PaneNode): PaneLeaf | null {
    if (node.type === "leaf") return node;
    return this.firstLeaf(node.first);
  }

  private walkLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => void): void {
    if (node.type === "leaf") { fn(node); return; }
    this.walkLeaves(node.first, fn);
    this.walkLeaves(node.second, fn);
  }

  private walkAll(node: PaneNode, fn: (node: PaneNode) => void): void {
    fn(node);
    if (node.type === "branch") {
      this.walkAll(node.first, fn);
      this.walkAll(node.second, fn);
    }
  }

  private getOrderedLeaves(axis: "horizontal" | "vertical"): PaneLeaf[] {
    // Flatten all leaves in order (left-to-right for horizontal, top-to-bottom for vertical)
    const leaves: PaneLeaf[] = [];
    this.walkLeaves(this.root, (leaf) => leaves.push(leaf));
    return leaves;
  }

  private updateSoloClass(): void {
    const count = this.getPaneCount();
    this.walkLeaves(this.root, (leaf) => {
      leaf.el.classList.toggle("pane-solo", count === 1);
    });
  }

  private setupDivider(
    dividerEl: HTMLDivElement,
    direction: "horizontal" | "vertical",
    getBranch: () => HTMLElement,
  ): void {
    let dragging = false;
    let startPos = 0;
    let startSize = 0;

    dividerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      const branch = getBranch();
      startPos = direction === "horizontal" ? e.clientX : e.clientY;
      startSize = direction === "horizontal" ? branch.clientWidth : branch.clientHeight;

      const onMove = (me: MouseEvent) => {
        if (!dragging) return;
        const currentPos = direction === "horizontal" ? me.clientX : me.clientY;
        const delta = currentPos - startPos;
        const branchSize = direction === "horizontal" ? getBranch().clientWidth : getBranch().clientHeight;
        const newRatio = Math.max(0.15, Math.min(0.85, (startSize * 0.5 + delta) / branchSize));

        const children = getBranch().querySelectorAll(":scope > .pane-leaf, :scope > .pane-branch");
        if (children.length >= 2) {
          (children[0] as HTMLElement).style.flex = `${newRatio}`;
          (children[children.length - 1] as HTMLElement).style.flex = `${1 - newRatio}`;
        }
      };

      const onUp = () => {
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        this.resizeAll();
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Double-click to reset 50/50
    dividerEl.addEventListener("dblclick", () => {
      const children = getBranch().querySelectorAll(":scope > .pane-leaf, :scope > .pane-branch");
      if (children.length >= 2) {
        (children[0] as HTMLElement).style.flex = "0.5";
        (children[children.length - 1] as HTMLElement).style.flex = "0.5";
      }
      this.resizeAll();
    });
  }
}
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: Error because `TabSession.setFocused()` doesn't exist yet. That's OK — Task 2 adds it.

- [ ] **Step 3: Commit**

```bash
git add src/panes/pane-layout.ts
git commit -m "feat: PaneLayout binary tree — split, close, navigate, zoom, resize"
```

---

### Task 2: TabSession — Add setFocused + Pane CSS

**Files:**
- Modify: `src/tabs/tab-session.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add `setFocused()` method to TabSession**

In `src/tabs/tab-session.ts`, add after the `onCwdChanged` method:

```typescript
  /** Set pane-level focus state (within a visible tab's split layout) */
  setFocused(focused: boolean): void {
    // No-op for now — the PaneLayout manages the .active class on the wrapper
  }
```

Also, change the constructor so it does NOT append `containerEl` to `parentContainer` — the PaneLayout handles DOM parenting now. Change:

```typescript
    this.containerEl = document.createElement("div");
    this.containerEl.className = "tab-panel";
    this.containerEl.style.display = "none";
    this.containerEl.dataset.tabId = id;
    parentContainer.appendChild(this.containerEl);
```

to:

```typescript
    this.containerEl = document.createElement("div");
    this.containerEl.className = "tab-panel";
    this.containerEl.dataset.tabId = id;
    // Note: PaneLayout manages DOM parenting and visibility, not TabSession
```

Remove `this.containerEl.style.display = "none"` — visibility is controlled by PaneLayout and TabManager.

Update `activate()` and `deactivate()` — these are called by TabManager for tab-level visibility. Keep them but update:

```typescript
  activate(): void {
    this._active = true;
    // Don't set display here — PaneLayout controls visibility via the leaf wrapper
    requestAnimationFrame(() => {
      const { rows, cols } = this.grid.measureGrid();
      this.grid.resize(rows, cols);
      if (this._started) {
        invoke("resize_session", { tabId: this.id, rows, cols }).catch(console.warn);
      }
    });
  }

  deactivate(): void {
    this._active = false;
    this.autocomplete.hide();
    if (this.search.isOpen) this.search.close();
  }
```

- [ ] **Step 2: Add pane CSS to wallace.css**

Append to the file:

```css
/* ── Pane layout ─────────────────────────────────────────────────────────── */

.pane-branch {
  display: flex;
  width: 100%;
  height: 100%;
  position: relative;
}

.pane-branch.horizontal { flex-direction: row; }
.pane-branch.vertical { flex-direction: column; }

.pane-leaf {
  position: relative;
  overflow: hidden;
  min-width: 80px;
  min-height: 40px;
  transition: opacity 0.15s ease;
}

.pane-leaf:not(.pane-solo):not(.active) { opacity: 0.6; }
.pane-leaf.active:not(.pane-solo) { border-left: 2px solid var(--koji-orange); }

.pane-divider {
  flex-shrink: 0;
  background: var(--koji-deep);
  z-index: 5;
}

.pane-divider.horizontal {
  width: 4px;
  cursor: col-resize;
}

.pane-divider.vertical {
  height: 4px;
  cursor: row-resize;
}

.pane-divider:hover { background: var(--koji-warm); }
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tabs/tab-session.ts src/styles/wallace.css
git commit -m "feat: TabSession pane support — setFocused, CSS for splits and dividers"
```

---

### Task 3: Integrate PaneLayout into TabManager

**Files:**
- Modify: `src/tabs/tab-manager.ts`

This is the big integration task. TabManager needs to own PaneLayouts instead of raw TabSessions.

- [ ] **Step 1: Refactor TabManager**

Replace the entire file with the updated version. Key changes:
- `tabs` map stores `PaneLayout` instead of `TabSession`
- `getActive()` returns the active pane's TabSession from the active tab's layout
- `getAllTabs()` returns all sessions across all layouts (for theme/font propagation)
- New methods: `splitActivePane()`, `closeActivePane()`, `focusPaneDirection()`, `togglePaneZoom()`
- `createTab()` creates a PaneLayout wrapping the new TabSession

```typescript
// tab-manager.ts — Tab bar UI, tab creation/closing/switching
// Each tab owns a PaneLayout (binary tree of TabSessions).

import { TabSession } from "./tab-session";
import { PaneLayout } from "../panes/pane-layout";
import { playLinkedAnimation } from "./linked-art";

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

  setTabName(tabId: string, name: string): void {
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

  private startRename(tabId: string, labelEl: HTMLSpanElement, session: TabSession | undefined): void {
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
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: PASS (or minor issues to fix)

- [ ] **Step 3: Commit**

```bash
git add src/tabs/tab-manager.ts
git commit -m "feat: integrate PaneLayout into TabManager — split, close, navigate, zoom"
```

---

### Task 4: Wire Keybindings + Proxy Icon + Tab Drag

**Files:**
- Modify: `src/main.ts`
- Modify: `index.html`
- Modify: `src/config/keybindings.ts`
- Modify: `src/styles/wallace.css`
- Modify: `resources/default-config.toml`

- [ ] **Step 1: Add new keybinding registrations in main.ts**

After the existing keybinding registrations, add:

```typescript
keybindings.register("split_right", "cmd+d", () => { tabManager.splitActivePane("horizontal").catch(console.error); });
keybindings.register("split_down", "cmd+shift+d", () => { tabManager.splitActivePane("vertical").catch(console.error); });
keybindings.register("close_pane", "cmd+shift+w", () => tabManager.closeActivePane());
keybindings.register("pane_left", "cmd+option+left", () => tabManager.focusPaneDirection("left"));
keybindings.register("pane_right", "cmd+option+right", () => tabManager.focusPaneDirection("right"));
keybindings.register("pane_up", "cmd+option+up", () => tabManager.focusPaneDirection("up"));
keybindings.register("pane_down", "cmd+option+down", () => tabManager.focusPaneDirection("down"));
keybindings.register("pane_zoom", "cmd+shift+enter", () => tabManager.togglePaneZoom());
```

- [ ] **Step 2: Add normalizeKey entries for "option" and "enter" in keybindings.ts**

In the `normalizeKey` function, add:
```typescript
    "enter": "enter",
```

In `matchesEvent`, handle the "Enter" key:
```typescript
    || (combo.key === "enter" && key === "enter")
```

And handle alt/option in parseKeyCombo — it already handles "alt" and "option", so this should work.

- [ ] **Step 3: Add proxy-path to index.html tab bar**

In `index.html`, inside the `.terminal-tabbar` div, after the `<button>` element:
```html
      <span class="proxy-path" id="proxy-path" title="Current directory"></span>
```

- [ ] **Step 4: Add tab drag CSS + proxy CSS + pane count badge to wallace.css**

```css
/* Tab drag */
.tab-drag-ghost {
  position: fixed;
  pointer-events: none;
  opacity: 0.7;
  z-index: 200;
}

.tab-drop-indicator {
  position: absolute;
  width: 2px;
  height: 100%;
  background: var(--koji-orange);
  z-index: 50;
  pointer-events: none;
}

/* Proxy icon */
.proxy-path {
  color: var(--koji-faded);
  font-size: 10px;
  margin-left: auto;
  padding-right: 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.proxy-path:hover { color: var(--koji-warm); }

/* Pane count badge */
.tabbar-pane-count {
  display: inline-block;
  background: var(--koji-deep);
  color: var(--koji-faded);
  font-size: 9px;
  padding: 0 4px;
  border-radius: 3px;
  margin-left: 4px;
  vertical-align: middle;
}

/* Tab layout wrapper */
.tab-layout-wrapper {
  position: absolute;
  inset: 0;
}
```

- [ ] **Step 5: Add new keybindings to default-config.toml**

Add to the `[keybindings]` section:
```toml
close_pane = "cmd+shift+w"
pane_left = "cmd+option+left"
pane_right = "cmd+option+right"
pane_up = "cmd+option+up"
pane_down = "cmd+option+down"
pane_zoom = "cmd+shift+enter"
```

- [ ] **Step 6: Update resize observer in main.ts**

The resize observer currently calls `tab.resize()`. Update it to resize all panes:

```typescript
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    // Resize all panes in the active tab
    for (const session of tabManager.getAllTabs()) {
      if (session.active) {
        const { rows, cols } = session.grid.measureGrid();
        session.resize(rows, cols);
      }
    }
  }, 50);
}).observe(container);
```

Actually simpler — the TabManager can expose the active layout's resizeAll. But for now, iterating active sessions works.

- [ ] **Step 7: Update font change callback**

The font callback should apply to all sessions, not just active:
```typescript
fontManager.setChangeCallback((font, size, ligatures) => {
  for (const session of tabManager.getAllTabs()) {
    session.grid.setFont(font, size, ligatures);
  }
  // Resize active panes
  const active = tabManager.getActive();
  if (active) {
    const { rows, cols } = active.grid.measureGrid();
    active.resize(rows, cols);
  }
});
```

- [ ] **Step 8: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 9: Run `npm run build`**

Expected: Clean build

- [ ] **Step 10: Commit**

```bash
git add src/main.ts src/config/keybindings.ts index.html src/styles/wallace.css resources/default-config.toml
git commit -m "feat: wire split/navigate/zoom keybindings, proxy icon, pane CSS"
```

---

### Task 5: Tab Drag Reorder

**Files:**
- Create: `src/tabs/tab-drag.ts`
- Modify: `src/tabs/tab-manager.ts`

- [ ] **Step 1: Create `src/tabs/tab-drag.ts`**

```typescript
// tab-drag.ts — Drag tabs to reorder them in the tab bar

export function enableTabDrag(
  tabsContainer: HTMLElement,
  onReorder: (fromIdx: number, toIdx: number) => void,
): void {
  let dragIdx = -1;
  let ghost: HTMLElement | null = null;
  let indicator: HTMLElement | null = null;
  let startX = 0;
  const DRAG_THRESHOLD = 5;

  tabsContainer.addEventListener("mousedown", (e) => {
    const tabEl = (e.target as HTMLElement).closest(".tabbar-tab") as HTMLElement | null;
    if (!tabEl) return;

    const tabs = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
    dragIdx = tabs.indexOf(tabEl);
    if (dragIdx < 0) return;

    startX = e.clientX;
    let dragging = false;

    const onMove = (me: MouseEvent) => {
      if (!dragging && Math.abs(me.clientX - startX) > DRAG_THRESHOLD) {
        dragging = true;
        // Create ghost
        ghost = tabEl.cloneNode(true) as HTMLElement;
        ghost.className = "tab-drag-ghost";
        ghost.style.width = `${tabEl.offsetWidth}px`;
        document.body.appendChild(ghost);

        // Create drop indicator
        indicator = document.createElement("div");
        indicator.className = "tab-drop-indicator";
        tabsContainer.appendChild(indicator);
      }

      if (!dragging || !ghost || !indicator) return;

      ghost.style.left = `${me.clientX - 20}px`;
      ghost.style.top = `${me.clientY - 10}px`;

      // Find drop position
      const tabEls = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
      let dropIdx = tabEls.length;
      for (let i = 0; i < tabEls.length; i++) {
        const rect = tabEls[i].getBoundingClientRect();
        if (me.clientX < rect.left + rect.width / 2) {
          dropIdx = i;
          break;
        }
      }

      // Position indicator
      if (dropIdx < tabEls.length) {
        const rect = tabEls[dropIdx].getBoundingClientRect();
        const containerRect = tabsContainer.getBoundingClientRect();
        indicator.style.left = `${rect.left - containerRect.left}px`;
        indicator.style.height = `${containerRect.height}px`;
      } else if (tabEls.length > 0) {
        const lastRect = tabEls[tabEls.length - 1].getBoundingClientRect();
        const containerRect = tabsContainer.getBoundingClientRect();
        indicator.style.left = `${lastRect.right - containerRect.left}px`;
        indicator.style.height = `${containerRect.height}px`;
      }
    };

    const onUp = (me: MouseEvent) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);

      if (dragging) {
        // Calculate final drop position
        const tabEls = Array.from(tabsContainer.querySelectorAll(".tabbar-tab"));
        let dropIdx = tabEls.length;
        for (let i = 0; i < tabEls.length; i++) {
          const rect = tabEls[i].getBoundingClientRect();
          if (me.clientX < rect.left + rect.width / 2) {
            dropIdx = i;
            break;
          }
        }

        if (dropIdx !== dragIdx && dropIdx !== dragIdx + 1) {
          const adjustedDrop = dropIdx > dragIdx ? dropIdx - 1 : dropIdx;
          onReorder(dragIdx, adjustedDrop);
        }
      }

      ghost?.remove();
      indicator?.remove();
      ghost = null;
      indicator = null;
      dragIdx = -1;
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
```

- [ ] **Step 2: Wire tab drag into TabManager**

In `tab-manager.ts`, import and call in constructor:

```typescript
import { enableTabDrag } from "./tab-drag";
```

In the constructor, after the "tabbar-new" click listener:
```typescript
    enableTabDrag(this.tabsContainerEl, (fromIdx, toIdx) => {
      const [moved] = this.tabOrder.splice(fromIdx, 1);
      this.tabOrder.splice(toIdx, 0, moved);
      this.renderTabBar();
    });
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tabs/tab-drag.ts src/tabs/tab-manager.ts
git commit -m "feat: tab drag reorder in tab bar"
```

---

### Task 6: Full Build + Verification

**Files:** None new.

- [ ] **Step 1: TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Rust tests**

Run: `cd src-tauri && cargo test -- --nocapture`
Expected: All 24 tests pass (no Rust changes in this batch)

- [ ] **Step 3: Frontend build**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Rust release build**

Run: `cd src-tauri && cargo build --release`
Expected: Clean compilation

- [ ] **Step 5: Commit if fixups needed**

```bash
git add -A && git commit -m "fix: Batch B build fixups"
```

---

### Task Summary

| Task | Component | Dependencies | Files touched |
|------|-----------|--------------|---------------|
| 1 | PaneLayout core | None | pane-layout.ts |
| 2 | TabSession pane support + CSS | None | tab-session.ts, wallace.css |
| 3 | TabManager integration | Tasks 1, 2 | tab-manager.ts |
| 4 | Keybindings, proxy, CSS | Tasks 1, 2, 3 | main.ts, keybindings.ts, index.html, wallace.css, default-config.toml |
| 5 | Tab drag reorder | Task 3 | tab-drag.ts, tab-manager.ts |
| 6 | Full build verification | All | — |
