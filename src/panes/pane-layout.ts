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
  readonly containerEl: HTMLElement;
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

  private getOrderedLeaves(_axis: "horizontal" | "vertical"): PaneLeaf[] {
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
