# Koji Baseline Batch B — Split Panes, Window Management, Polish

## Goal

Add split panes with keyboard navigation, pane zoom, focus dimming, draggable resize dividers, tab drag reordering, and a proxy icon showing the active CWD.

## Scope

7 features:

1. **PaneLayout** — binary tree layout managing multiple TabSessions per tab
2. **Split panes** — Cmd+D (right), Cmd+Shift+D (down)
3. **Pane navigation + close** — Cmd+Option+Arrow to move focus, Cmd+Shift+W to close pane
4. **Pane zoom** — Cmd+Shift+Enter toggles active pane fullscreen within tab
5. **Focus dimming** — inactive panes at 0.6 opacity
6. **Tab drag reorder** — mousedown+drag on tab bar reorders tabs
7. **Proxy icon** — CWD path display in title bar area

## Non-Goals

- Cross-tab pane movement (drag pane from one tab to another)
- Saved pane layouts / profiles (Batch D session restore)
- Pane-specific themes or fonts (all panes share tab config)

---

## Architecture

### 1. PaneLayout — Binary Tree (`src/panes/pane-layout.ts`)

Each tab owns one `PaneLayout`. The layout is a binary tree where:
- **Leaf nodes** contain a `TabSession` (the pane)
- **Branch nodes** contain a split direction and two children

```typescript
interface PaneLeaf {
  type: "leaf";
  session: TabSession;
  el: HTMLDivElement;  // wrapper element
}

interface PaneBranch {
  type: "branch";
  direction: "horizontal" | "vertical";
  ratio: number;  // 0.0–1.0, first child gets ratio * 100%
  first: PaneNode;
  second: PaneNode;
  el: HTMLDivElement;  // flex container
  divider: HTMLDivElement;  // draggable resize handle
}

type PaneNode = PaneLeaf | PaneBranch;
```

**PaneLayout class:**

```typescript
class PaneLayout {
  private root: PaneNode;
  private activePaneId: string;  // TabSession.id of the focused pane
  private containerEl: HTMLElement;
  
  constructor(container: HTMLElement, initialSession: TabSession)
  
  // Split the active pane
  splitActive(direction: "horizontal" | "vertical"): TabSession
  
  // Close a pane, collapsing its parent branch
  closePane(sessionId: string): void
  
  // Navigate focus
  focusDirection(dir: "left" | "right" | "up" | "down"): void
  
  // Zoom toggle
  toggleZoom(): void
  
  // Get the active pane's session
  getActiveSession(): TabSession
  
  // Get all sessions (for resize propagation, theme changes, etc.)
  getAllSessions(): TabSession[]
  
  // Resize all panes (called by ResizeObserver)
  resizeAll(): void
  
  // Cleanup
  destroy(): void
}
```

**DOM structure when split:**
```html
<div class="pane-branch horizontal">
  <div class="pane-leaf active" style="flex: 0.5">
    <!-- TabSession's containerEl (tab-panel) -->
  </div>
  <div class="pane-divider horizontal"></div>
  <div class="pane-leaf" style="flex: 0.5">
    <!-- TabSession's containerEl -->
  </div>
</div>
```

**How splitting works:**
1. Find the leaf containing the active session
2. Create a new TabSession (inherits CWD from active)
3. Replace the leaf with a branch node containing the old session and new session
4. Reparent DOM: old session's container and new session's container become children of a flex div
5. Insert a draggable divider between them
6. Start the new session's PTY
7. Focus the new pane

**How closing works:**
1. Find the leaf to close
2. Close its TabSession (PTY, listeners, DOM)
3. Find its parent branch
4. Replace the branch with the sibling leaf (collapse)
5. If it was the last pane in the tab, close the tab

### 2. Draggable Dividers (`src/panes/pane-divider.ts`)

A thin (4px) draggable bar between split panes. Horizontal splits get a vertical divider, vertical splits get a horizontal divider.

**Behavior:**
- mousedown on divider starts drag
- mousemove updates the `ratio` on the parent branch
- mouseup ends drag
- Double-click resets to 50/50

**Implementation:**
```typescript
export function createDivider(
  direction: "horizontal" | "vertical",
  onRatioChange: (ratio: number) => void,
): HTMLDivElement
```

The divider element handles its own mouse events. On ratio change, the callback updates the flex values on sibling panes and triggers resize on both.

### 3. Pane Navigation

**Cmd+Option+Arrow** moves focus to the nearest pane in that direction.

Algorithm: From the active leaf, walk up the tree to find the nearest branch that splits in the relevant axis, then walk down the opposite child to find the nearest leaf.

- Cmd+Option+Left → find pane to the left
- Cmd+Option+Right → find pane to the right
- Cmd+Option+Up → find pane above
- Cmd+Option+Down → find pane below

**Cmd+Shift+W** closes the active pane. If it's the only pane, closes the tab (delegates to `tabManager.closeActiveTab()`).

### 4. Pane Zoom

**Cmd+Shift+Enter** toggles zoom mode:
- **Zoom in:** Hide all panes except active. Active pane expands to fill the tab. Store the layout state.
- **Zoom out:** Restore the layout. Show all panes again.

Implementation: Toggle a `zoomed` flag on PaneLayout. When zoomed, set all non-active pane wrappers to `display: none` and the active pane to `flex: 1`. When unzoomed, restore original flex values.

### 5. Focus Dimming

**Active pane:** Full opacity, subtle border highlight (2px left border in `--koji-orange`).
**Inactive panes:** `opacity: 0.6` on the pane wrapper.

CSS:
```css
.pane-leaf { transition: opacity 0.15s ease; }
.pane-leaf:not(.active) { opacity: 0.6; }
.pane-leaf.active { border-left: 2px solid var(--koji-orange); }
```

The single-pane case: when a tab has only one pane, no dimming or border (it's always active).

### 6. Tab Drag Reorder (`src/tabs/tab-drag.ts`)

Drag tabs to reorder them in the tab bar.

**Behavior:**
- mousedown on a tab starts potential drag (after 5px threshold)
- mousemove moves a ghost element, calculates drop position
- mouseup drops the tab at the new position, updates `tabOrder` array
- Visual feedback: insertion indicator line between tabs

**Implementation:**
```typescript
export function enableTabDrag(
  tabsContainer: HTMLElement,
  onReorder: (fromIdx: number, toIdx: number) => void,
): void
```

Called once from TabManager constructor. The callback updates `this.tabOrder` and re-renders.

### 7. Proxy Icon

A small path display in the tab bar area showing the active pane's CWD. Clicking copies the path. Cmd+click shows path hierarchy popup.

**Implementation:** Add a `<span class="proxy-path">` element to the tab bar, updated when the active pane's CWD changes. Format: `~/projects/koji-baseline` (tilde-collapsed).

---

## Integration with Existing Code

### TabManager changes

TabManager currently owns `Map<string, TabSession>` and `tabOrder`. With PaneLayout:

- Each tab ID maps to a `PaneLayout` (not a TabSession)
- `getActive()` returns the active pane's TabSession (from the active tab's layout)
- `createTab()` creates a PaneLayout with one initial pane
- New methods: `splitActivePane(direction)`, `closeActivePane()`, `focusPaneDirection(dir)`, `togglePaneZoom()`
- The resize observer calls `layout.resizeAll()` instead of single session resize
- Font changes propagate to `layout.getAllSessions()` instead of single session
- Theme changes already iterate `getAllTabs()` — needs to iterate all sessions across all layouts

### TabSession changes (minimal)

- Add `.paneWrapperEl` — the `.pane-leaf` div that wraps the session's `.tab-panel`
- Add `.setFocused(bool)` — toggles the `.active` class on the wrapper for dimming
- The existing `.activate()` / `.deactivate()` stay for tab-level visibility
- New: `.setFocused()` is for pane-level focus within a visible tab

### main.ts changes

Register new keybindings:
```typescript
keybindings.register("split_right", "cmd+d", () => tabManager.splitActivePane("horizontal"));
keybindings.register("split_down", "cmd+shift+d", () => tabManager.splitActivePane("vertical"));
keybindings.register("close_pane", "cmd+shift+w", () => tabManager.closeActivePane());
keybindings.register("pane_left", "cmd+option+left", () => tabManager.focusPaneDirection("left"));
keybindings.register("pane_right", "cmd+option+right", () => tabManager.focusPaneDirection("right"));
keybindings.register("pane_up", "cmd+option+up", () => tabManager.focusPaneDirection("up"));
keybindings.register("pane_down", "cmd+option+down", () => tabManager.focusPaneDirection("down"));
keybindings.register("pane_zoom", "cmd+shift+enter", () => tabManager.togglePaneZoom());
```

---

## CSS

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
```

---

## File Changes (execution order)

| Order | File | Change | Est. lines |
|-------|------|--------|-----------|
| 1 | `src/panes/pane-layout.ts` (NEW) | Binary tree layout, split, close, navigate, zoom | ~250 |
| 2 | `src/panes/pane-divider.ts` (NEW) | Draggable resize dividers | ~80 |
| 3 | `src/tabs/tab-session.ts` | Add paneWrapperEl, setFocused() | ~15 |
| 4 | `src/tabs/tab-manager.ts` | Integrate PaneLayout, new methods | ~80 |
| 5 | `src/tabs/tab-drag.ts` (NEW) | Tab drag reorder | ~80 |
| 6 | `src/main.ts` | Register split/navigate/zoom keybindings | ~15 |
| 7 | `src/config/keybindings.ts` | Add normalizeKey for "option", "enter" | ~5 |
| 8 | `index.html` | Add proxy-path span to tab bar | ~1 |
| 9 | `src/styles/wallace.css` | All pane/divider/drag/proxy CSS | ~60 |
| 10 | `resources/default-config.toml` | Add new keybinding defaults | ~10 |

**Estimated total: ~596 lines new/changed**

---

## Testing Strategy

### Manual Test Checklist

- [ ] Single pane tab works exactly as before (no regression)
- [ ] Cmd+D splits active pane right — new pane has shell prompt, inherits CWD
- [ ] Cmd+Shift+D splits active pane down
- [ ] Nested splits work (split a split)
- [ ] Cmd+Option+Arrow navigates between panes
- [ ] Active pane has orange left border, inactive panes dimmed
- [ ] Typing goes to active pane only
- [ ] Dragging divider resizes panes proportionally
- [ ] Double-click divider resets to 50/50
- [ ] Both panes resize correctly when window resizes
- [ ] Cmd+Shift+W closes active pane, sibling expands
- [ ] Closing last pane in tab closes the tab
- [ ] Cmd+Shift+Enter zooms active pane (fills tab)
- [ ] Cmd+Shift+Enter again restores split layout
- [ ] Tab drag reorders tabs in tab bar
- [ ] Proxy path shows active CWD, updates on cd
- [ ] Theme change applies to all panes across all tabs
- [ ] Font change applies to all panes
- [ ] Cmd+T new tab still works (single pane, inherits CWD from active pane)
- [ ] Cmd+W closes tab (all panes in it)
