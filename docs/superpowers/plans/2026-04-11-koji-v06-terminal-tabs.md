# Kōji Baseline v0.6 — Terminal Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tab terminal support — each tab gets its own PTY, scrollback, and state. Tab bar with `+` button, "Linked" ASCII animation on new tab, Cmd+T/W/1-9 shortcuts.

**Architecture:** Rust backend replaces single PtyState/EngineState with a SessionMap (HashMap keyed by tab ID). Each session has its own PTY, TerminalEngine, and I/O thread emitting tab-scoped events (`terminal-output-{id}`). Frontend TabManager owns the tab bar DOM, maintains a Map of TabSession objects (each with its own DOMGrid, MouseReporter, Autocomplete, SelectionManager), and routes keyboard/resize events to the active tab.

**Tech Stack:** Rust (SessionMap, per-tab I/O threads, Tauri events), TypeScript (TabManager, TabSession, tab bar DOM, "Linked" animation), CSS (tab bar styling with theme vars).

**Spec:** `docs/superpowers/specs/2026-04-11-koji-v06-terminal-tabs-design.md`

**Project location:** `/Users/hanamori/koji-baseline/`

---

## Phase 1: Rust Backend — Session Map (Task 1)

### Task 1: Replace Single PTY/Engine State with SessionMap

Convert the Rust backend from a single PTY+Engine to a map of sessions keyed by tab ID. Add session-scoped Tauri commands.

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Replace state structs with SessionMap**

In `src-tauri/src/lib.rs`, replace the existing state structs (around lines 19-22):

```rust
// DELETE these:
// struct PtyState(Arc<Mutex<Option<pty::PtyManager>>>);
// struct EngineState(Arc<Mutex<Option<terminal::TerminalEngine>>>);

// ADD:
use std::collections::HashMap;

struct Session {
    pty: pty::PtyManager,
    engine: terminal::TerminalEngine,
}

struct SessionMap(Arc<Mutex<HashMap<String, Session>>>);
```

Keep `OllamaState` and `OpenAICompatState` unchanged — those are shared across all tabs.

- [ ] **Step 2: Update the Tauri builder to use SessionMap**

In the `tauri::Builder` setup (around line 610), replace the state management:

```rust
// DELETE:
// .manage(PtyState(Arc::new(Mutex::new(None))))
// .manage(EngineState(Arc::new(Mutex::new(None))))

// ADD:
.manage(SessionMap(Arc::new(Mutex::new(HashMap::new()))))
```

- [ ] **Step 3: Rewrite init_terminal as create_session**

Replace the `init_terminal` function with `create_session` that returns a tab ID:

```rust
#[tauri::command]
fn create_session(
    rows: Option<u16>,
    cols: Option<u16>,
    sessions: State<'_, SessionMap>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    let r = rows.unwrap_or(24);
    let c = cols.unwrap_or(80);

    let tab_id = format!("tab-{}", uuid_simple());

    let pty_manager = pty::PtyManager::new(r, c)
        .map_err(|e| format!("PTY spawn failed: {e}"))?;

    let engine = terminal::TerminalEngine::new(r as usize, c as usize);

    let reader_arc = pty_manager.take_reader();

    // Store session
    {
        let mut map = sessions.0.lock();
        map.insert(tab_id.clone(), Session { pty: pty_manager, engine });
    }

    // Spawn I/O thread for this tab
    let sessions_arc = sessions.0.clone();
    let tid = tab_id.clone();
    let app_handle = app.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            let n = {
                let mut reader = reader_arc.lock().unwrap();
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Err(_) => break,
                    Ok(n) => n,
                }
            };

            let has_bell = terminal::TerminalEngine::check_bell(&buf[..n]);

            let (scrollback, snap) = {
                let mut map = sessions_arc.lock();
                if let Some(session) = map.get_mut(&tid) {
                    session.engine.process_bytes(&buf[..n]);
                    let sb = session.engine.drain_scrollback();
                    let s = session.engine.snapshot();
                    (sb, Some(s))
                } else {
                    break; // Session removed
                }
            };

            if !scrollback.is_empty() {
                let _ = app_handle.emit(&format!("scrollback-append-{}", tid), &scrollback);
            }

            if let Some(snap) = snap {
                let _ = app_handle.emit(&format!("terminal-output-{}", tid), &snap);
            }

            if has_bell {
                let _ = app_handle.emit(&format!("terminal-bell-{}", tid), ());
            }
        }

        // Cleanup: remove session from map when PTY exits
        let mut map = sessions_arc.lock();
        map.remove(&tid);
        let _ = app_handle.emit(&format!("session-closed-{}", tid), ());
    });

    Ok(tab_id)
}

/// Simple unique ID generator (no uuid crate needed)
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", ts)
}
```

- [ ] **Step 4: Add session-scoped write and resize commands**

```rust
#[tauri::command]
fn write_to_session(tab_id: String, data: Vec<u8>, sessions: State<'_, SessionMap>) -> Result<(), String> {
    let map = sessions.0.lock();
    if let Some(session) = map.get(&tab_id) {
        session.pty.write(&data).map_err(|e| format!("write failed: {e}"))
    } else {
        Err(format!("Session {} not found", tab_id))
    }
}

#[tauri::command]
fn resize_session(tab_id: String, rows: u16, cols: u16, sessions: State<'_, SessionMap>) -> Result<(), String> {
    let mut map = sessions.0.lock();
    if let Some(session) = map.get_mut(&tab_id) {
        session.engine.resize(rows as usize, cols as usize);
        session.pty.resize(rows, cols)?;
        Ok(())
    } else {
        Err(format!("Session {} not found", tab_id))
    }
}

#[tauri::command]
fn close_session(tab_id: String, sessions: State<'_, SessionMap>) -> Result<(), String> {
    let mut map = sessions.0.lock();
    map.remove(&tab_id);
    Ok(())
}
```

- [ ] **Step 5: Keep old commands as wrappers (backward compat during migration)**

Don't remove the old `init_terminal`, `write_to_pty`, `resize_terminal` yet — they'll be removed in the wiring task. For now, keep them but they can be broken (they reference the old state types that no longer exist). Actually, since we removed PtyState/EngineState, they won't compile. Remove them:

Delete the old `init_terminal`, `write_to_pty`, `resize_terminal` functions entirely.

- [ ] **Step 6: Update generate_handler! macro**

Replace the old commands with new ones in the handler list:

```rust
// REMOVE: init_terminal, write_to_pty, resize_terminal
// ADD: create_session, write_to_session, resize_session, close_session
```

Also add the `use std::io::Read;` import if not already present (needed for the reader thread).

- [ ] **Step 7: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

Note: TypeScript will NOT compile after this step because it still calls `init_terminal`, `write_to_pty`, `resize_terminal`. That's expected — the frontend is wired in Tasks 5-6.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: Rust session map — per-tab PTY with scoped events and commands"
```

---

## Phase 2: Frontend Foundation (Tasks 2-4)

### Task 2: Tab Bar HTML, CSS, and "Linked" ASCII Art

Add the tab bar DOM structure, styling, and the "Linked" animation asset.

**Files:**
- Modify: `index.html`
- Modify: `src/styles/wallace.css`
- Create: `src/tabs/linked-art.ts`

- [ ] **Step 1: Add tab bar div to index.html**

In `index.html`, insert between `</div>` (end of dashboard-top, around line 26) and the terminal-viewport div:

```html
    <!-- ── Tab bar ────────────────────────────────────── -->
    <div class="terminal-tabbar" id="terminal-tabbar">
      <div class="tabbar-tabs" id="tabbar-tabs"></div>
      <button class="tabbar-new" id="tabbar-new" title="New tab (Cmd+T)">+</button>
    </div>
```

- [ ] **Step 2: Add tab bar CSS**

Append to `src/styles/wallace.css`:

```css
/* ── Tab bar ─────────────────────────────────────────────────────────────── */

.terminal-tabbar {
  display: flex;
  align-items: center;
  height: 28px;
  background: var(--koji-void);
  border-bottom: 1px solid var(--koji-deep);
  padding: 0 4px;
  overflow: hidden;
  flex-shrink: 0;
}

.tabbar-tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  gap: 1px;
  scrollbar-width: none;
}

.tabbar-tabs::-webkit-scrollbar {
  display: none;
}

.tabbar-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  height: 28px;
  font-size: 11px;
  color: var(--koji-faded);
  cursor: pointer;
  white-space: nowrap;
  border-top: 2px solid transparent;
  flex-shrink: 0;
  position: relative;
}

.tabbar-tab:hover {
  background: var(--koji-dim);
  color: var(--koji-warm);
}

.tabbar-tab.active {
  color: var(--koji-bright);
  background: var(--koji-deep);
  border-top-color: var(--koji-orange);
}

.tabbar-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.tabbar-tab-close {
  display: none;
  font-size: 10px;
  color: var(--koji-faded);
  cursor: pointer;
  padding: 0 2px;
  line-height: 1;
}

.tabbar-tab:hover .tabbar-tab-close {
  display: inline;
}

.tabbar-tab-close:hover {
  color: var(--koji-error);
}

.tabbar-new {
  background: transparent;
  border: none;
  color: var(--koji-faded);
  font-size: 16px;
  cursor: pointer;
  padding: 0 8px;
  height: 28px;
  line-height: 28px;
  flex-shrink: 0;
}

.tabbar-new:hover {
  color: var(--koji-bright);
}

/* ── "Linked" animation overlay ──────────────────────────────────────────── */

.linked-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  font-family: inherit;
  font-size: inherit;
}

.linked-text {
  color: var(--koji-bright);
  font-size: 24px;
  font-weight: bold;
  letter-spacing: 8px;
  text-transform: uppercase;
  opacity: 1;
  transition: opacity 1.5s ease-out;
}

.linked-text.fade-out {
  opacity: 0;
}
```

- [ ] **Step 3: Create linked-art.ts**

Create `src/tabs/linked-art.ts`:

```typescript
// linked-art.ts — "LINKED" ASCII art animation for new tab creation

export function playLinkedAnimation(container: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.className = "linked-overlay";

  const text = document.createElement("div");
  text.className = "linked-text";
  text.textContent = "L I N K E D";
  overlay.appendChild(text);

  container.appendChild(overlay);

  // Trigger fade after a brief display
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      text.classList.add("fade-out");
    });
  });

  // Remove from DOM after fade completes
  setTimeout(() => {
    overlay.remove();
  }, 1800);
}
```

- [ ] **Step 4: Verify TypeScript compiles (linked-art.ts only — main.ts will be broken)**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit src/tabs/linked-art.ts 2>&1 || true
```

The full project won't compile yet since main.ts still references old Tauri commands.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: tab bar HTML/CSS + Linked animation asset"
```

---

### Task 3: TabSession Class

Create the per-tab state container that encapsulates everything a single terminal session needs.

**Files:**
- Create: `src/tabs/tab-session.ts`

- [ ] **Step 1: Create tab-session.ts**

Create `src/tabs/tab-session.ts`:

```typescript
// tab-session.ts — Per-tab terminal state: grid, mouse, selection, autocomplete, events

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DOMGrid, type GridSnapshot, type RenderCell } from "../terminal/dom-grid";
import { MouseReporter } from "../terminal/mouse";
import { SelectionManager } from "../terminal/selection";
import { Autocomplete } from "../terminal/autocomplete";
import { TransitionEffects } from "../animation/effects";
import { TerminalSearch } from "../terminal/search";
import { applyClickableRegions } from "../terminal/clickable";

export class TabSession {
  readonly id: string;
  readonly grid: DOMGrid;
  readonly mouse: MouseReporter;
  readonly selection: SelectionManager;
  readonly effects: TransitionEffects;
  readonly autocomplete: Autocomplete;
  readonly search: TerminalSearch;

  /** The container div for this tab's terminal content. */
  readonly containerEl: HTMLDivElement;

  private unlisteners: UnlistenFn[] = [];
  private clickableTimer: ReturnType<typeof setTimeout> | null = null;
  private _name = "terminal";
  private _active = false;

  /** Track typed input for autocomplete and slash command interception. */
  currentInput = "";

  constructor(id: string, parentContainer: HTMLElement) {
    this.id = id;

    // Create a container div for this tab's grid (hidden by default)
    this.containerEl = document.createElement("div");
    this.containerEl.className = "tab-panel";
    this.containerEl.style.display = "none";
    this.containerEl.dataset.tabId = id;
    parentContainer.appendChild(this.containerEl);

    // Overlay div for this tab
    const overlayDiv = document.createElement("div");
    overlayDiv.className = "terminal-overlay";
    this.containerEl.appendChild(overlayDiv);

    // Init grid and peripherals
    this.grid = new DOMGrid(this.containerEl);
    this.mouse = new MouseReporter(this.grid);
    this.selection = new SelectionManager(this.grid.getGridElement());
    this.effects = new TransitionEffects(this.grid.getGridElement());
    this.autocomplete = new Autocomplete(this.grid.getGridElement(), this.grid);
    this.search = new TerminalSearch(this.grid.getGridElement(), this.grid);
  }

  get name(): string {
    return this._name;
  }

  set name(value: string) {
    this._name = value;
  }

  get active(): boolean {
    return this._active;
  }

  /** Start the session — create backend PTY and wire event listeners. */
  async start(): Promise<void> {
    const { rows, cols } = this.grid.measureGrid();
    this.grid.resize(rows, cols);

    // Create backend session
    await invoke("create_session", { rows, cols });

    // Listen for tab-scoped events
    const outputUn = await listen<GridSnapshot>(`terminal-output-${this.id}`, (event) => {
      this.grid.render(event.payload);
      this.mouse.updateMode(event.payload.mouse_mode);

      if (event.payload.title) {
        document.title = event.payload.title;
      }

      // Debounced clickable detection
      if (this.clickableTimer) clearTimeout(this.clickableTimer);
      this.clickableTimer = setTimeout(() => {
        applyClickableRegions(this.grid.getScrollElement(), event.payload.mouse_mode).catch(() => {});
      }, 200);
    });
    this.unlisteners.push(outputUn);

    const scrollUn = await listen<RenderCell[][]>(`scrollback-append-${this.id}`, (event) => {
      this.grid.appendScrollback(event.payload);
    });
    this.unlisteners.push(scrollUn);

    const bellUn = await listen(`terminal-bell-${this.id}`, () => {
      this.effects.bell();
    });
    this.unlisteners.push(bellUn);
  }

  /** Show this tab's content. */
  activate(): void {
    this._active = true;
    this.containerEl.style.display = "";
    // Resize grid to fit container
    const { rows, cols } = this.grid.measureGrid();
    this.grid.resize(rows, cols);
    invoke("resize_session", { tabId: this.id, rows, cols }).catch(console.warn);
  }

  /** Hide this tab's content. */
  deactivate(): void {
    this._active = false;
    this.containerEl.style.display = "none";
    this.autocomplete.hide();
    if (this.search.isOpen) this.search.close();
  }

  /** Write bytes to this tab's PTY. */
  async writePty(data: number[]): Promise<void> {
    await invoke("write_to_session", { tabId: this.id, data });
  }

  /** Resize this tab's PTY and grid. */
  async resize(rows: number, cols: number): Promise<void> {
    this.grid.resize(rows, cols);
    await invoke("resize_session", { tabId: this.id, rows, cols });
  }

  /** Close this tab — cleanup listeners and destroy PTY. */
  async close(): Promise<void> {
    for (const unlisten of this.unlisteners) {
      unlisten();
    }
    this.unlisteners = [];

    if (this.clickableTimer) clearTimeout(this.clickableTimer);

    this.grid.destroy();
    this.containerEl.remove();

    // Close backend session (ignore errors — PTY may have already exited)
    await invoke("close_session", { tabId: this.id }).catch(() => {});
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: TabSession class — per-tab state encapsulation"
```

---

### Task 4: TabManager — Tab Bar UI and Orchestration

Create the TabManager that owns the tab bar, creates/closes/switches tabs, and handles tab keyboard shortcuts.

**Files:**
- Create: `src/tabs/tab-manager.ts`

- [ ] **Step 1: Create tab-manager.ts**

Create `src/tabs/tab-manager.ts`:

```typescript
// tab-manager.ts — Tab bar UI, tab creation/closing/switching, keyboard shortcuts

import { TabSession } from "./tab-session";
import { playLinkedAnimation } from "./linked-art";

export class TabManager {
  private tabs: Map<string, TabSession> = new Map();
  private tabOrder: string[] = [];
  private activeTabId = "";
  private parentContainer: HTMLElement;
  private tabBarEl: HTMLElement;
  private tabsContainerEl: HTMLElement;
  private onNameChange: ((id: string, name: string) => void) | null = null;

  constructor(parentContainer: HTMLElement) {
    this.parentContainer = parentContainer;

    this.tabBarEl = document.getElementById("terminal-tabbar")!;
    this.tabsContainerEl = document.getElementById("tabbar-tabs")!;

    // Wire the + button
    const newBtn = document.getElementById("tabbar-new")!;
    newBtn.addEventListener("click", () => this.createTab());
  }

  /** Get the active tab session. */
  getActive(): TabSession | undefined {
    return this.tabs.get(this.activeTabId);
  }

  /** Get all tabs. */
  getAllTabs(): TabSession[] {
    return this.tabOrder.map((id) => this.tabs.get(id)!);
  }

  getTabCount(): number {
    return this.tabs.size;
  }

  /** Create a new tab, make it active. */
  async createTab(): Promise<TabSession> {
    const id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const session = new TabSession(id, this.parentContainer);
    this.tabs.set(id, session);
    this.tabOrder.push(id);

    // Deactivate current tab
    const current = this.getActive();
    if (current) current.deactivate();

    // Activate new tab
    this.activeTabId = id;
    session.activate();

    // Start PTY
    await session.start();

    // Play "Linked" animation (non-blocking)
    playLinkedAnimation(session.containerEl);

    // Render tab bar
    this.renderTabBar();

    return session;
  }

  /** Close a tab by ID. If last tab, create a new one. */
  async closeTab(id: string): Promise<void> {
    const session = this.tabs.get(id);
    if (!session) return;

    await session.close();
    this.tabs.delete(id);
    this.tabOrder = this.tabOrder.filter((t) => t !== id);

    // If we closed the active tab, switch to nearest
    if (this.activeTabId === id) {
      if (this.tabOrder.length > 0) {
        const nextId = this.tabOrder[Math.max(0, this.tabOrder.length - 1)];
        this.switchTo(nextId);
      } else {
        // Last tab closed — create a new one
        await this.createTab();
        return;
      }
    }

    this.renderTabBar();
  }

  /** Close the active tab. */
  async closeActiveTab(): Promise<void> {
    if (this.activeTabId) {
      await this.closeTab(this.activeTabId);
    }
  }

  /** Switch to a tab by ID. */
  switchTo(id: string): void {
    if (id === this.activeTabId) return;
    const session = this.tabs.get(id);
    if (!session) return;

    // Deactivate current
    const current = this.getActive();
    if (current) current.deactivate();

    // Activate new
    this.activeTabId = id;
    session.activate();
    this.renderTabBar();
  }

  /** Switch to next tab. */
  nextTab(): void {
    const idx = this.tabOrder.indexOf(this.activeTabId);
    if (idx < 0) return;
    const nextIdx = (idx + 1) % this.tabOrder.length;
    this.switchTo(this.tabOrder[nextIdx]);
  }

  /** Switch to previous tab. */
  prevTab(): void {
    const idx = this.tabOrder.indexOf(this.activeTabId);
    if (idx < 0) return;
    const prevIdx = (idx - 1 + this.tabOrder.length) % this.tabOrder.length;
    this.switchTo(this.tabOrder[prevIdx]);
  }

  /** Switch to tab by number (1-indexed). */
  switchToNumber(n: number): void {
    if (n >= 1 && n <= this.tabOrder.length) {
      this.switchTo(this.tabOrder[n - 1]);
    }
  }

  /** Update a tab's name (called from CWD change). */
  setTabName(id: string, name: string): void {
    const session = this.tabs.get(id);
    if (session) {
      session.name = name;
      this.renderTabBar();
    }
  }

  // ── Tab bar rendering ─────────────────────────────────────────────────

  private renderTabBar(): void {
    this.tabsContainerEl.innerHTML = "";

    for (const id of this.tabOrder) {
      const session = this.tabs.get(id);
      if (!session) continue;

      const tab = document.createElement("div");
      tab.className = "tabbar-tab" + (id === this.activeTabId ? " active" : "");
      tab.dataset.tabId = id;

      const label = document.createElement("span");
      label.className = "tabbar-tab-label";
      label.textContent = session.name;

      // Double-click to rename
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startRename(id, label);
      });

      const close = document.createElement("span");
      close.className = "tabbar-tab-close";
      close.textContent = "×";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(id);
      });

      tab.appendChild(label);
      tab.appendChild(close);

      tab.addEventListener("click", () => this.switchTo(id));

      this.tabsContainerEl.appendChild(tab);
    }
  }

  private startRename(id: string, labelEl: HTMLSpanElement): void {
    const session = this.tabs.get(id);
    if (!session) return;

    const input = document.createElement("input");
    input.type = "text";
    input.value = session.name;
    input.className = "tabbar-tab-label";
    input.style.cssText = "background:transparent;border:1px solid var(--koji-dim);color:var(--koji-bright);font:inherit;font-size:inherit;padding:0 2px;width:100px;outline:none;";

    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
      const newName = input.value.trim() || session.name;
      session.name = newName;
      const newLabel = document.createElement("span");
      newLabel.className = "tabbar-tab-label";
      newLabel.textContent = newName;
      newLabel.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startRename(id, newLabel);
      });
      input.replaceWith(newLabel);
    };

    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = session.name; input.blur(); }
      e.stopPropagation(); // Don't let keystrokes reach terminal
    });
  }
}
```

- [ ] **Step 2: Add tab-panel CSS**

Append to `src/styles/wallace.css`:

```css
/* Tab panel — each tab's terminal content container */
.tab-panel {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: TabManager — tab bar UI, create/close/switch/rename tabs"
```

---

## Phase 3: Wire Everything Together (Tasks 5-6)

### Task 5: Rewire main.ts to Use TabManager

Replace all global terminal state in main.ts with the TabManager. This is the biggest single change.

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Rewrite main.ts**

This is a significant rewrite. The key changes:
- Remove all single-session globals (domGrid, mouse, selection, effects, autocomplete, search)
- Create TabManager, create first tab
- Route all keyboard events through `tabManager.getActive()`
- Route resize through active tab
- Keep shared state: themeManager, fontManager, llm, idle, optionAsMeta

Replace the entire content of `src/main.ts`. The new file follows the same structure but uses TabManager:

Key sections to change:

**Imports**: Add TabManager, remove direct DOMGrid/MouseReporter/SelectionManager/Autocomplete/TransitionEffects/TerminalSearch imports (they're used inside TabSession now).

**Initialization**: Replace `export const domGrid = new DOMGrid(container)` with:
```typescript
export const tabManager = new TabManager(container);
const firstTab = await tabManager.createTab();
```

**Font manager callback**: Route to active tab:
```typescript
fontManager.setChangeCallback((font, size, ligatures) => {
  const tab = tabManager.getActive();
  if (!tab) return;
  tab.grid.setFont(font, size, ligatures);
  const { rows, cols } = tab.grid.measureGrid();
  tab.resize(rows, cols);
});
```

**Resize observer**: Route to active tab:
```typescript
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const tab = tabManager.getActive();
    if (!tab) return;
    const { rows, cols } = tab.grid.measureGrid();
    tab.resize(rows, cols);
  }, 50);
}).observe(container);
```

**Keyboard handler**: Replace all `domGrid.xxx` calls with `tab.grid.xxx`, `autocomplete.xxx` with `tab.autocomplete.xxx`, `selection.xxx` with `tab.selection.xxx`, etc. Get active tab at start of handler:
```typescript
const tab = tabManager.getActive();
if (!tab) return;
```

Replace `invoke("write_to_pty", { data: bytes })` with `tab.writePty(bytes)`.

**Add tab shortcuts** (before other Cmd+ shortcuts):
```typescript
if (metaKey && key === "t") {
  event.preventDefault();
  tabManager.createTab();
  return;
}
if (metaKey && key === "w") {
  event.preventDefault();
  tabManager.closeActiveTab();
  return;
}
if (metaKey && event.shiftKey && key === "]") {
  event.preventDefault();
  tabManager.nextTab();
  return;
}
if (metaKey && event.shiftKey && key === "[") {
  event.preventDefault();
  tabManager.prevTab();
  return;
}
// Cmd+1 through Cmd+9
if (metaKey && key >= "1" && key <= "9") {
  event.preventDefault();
  tabManager.switchToNumber(parseInt(key));
  return;
}
```

**Remove**: The `init_terminal` invoke, the `listen("terminal-output")`, `listen("scrollback-append")`, `listen("terminal-bell")` calls — these are now inside TabSession.

**Keep**: The `listen("theme-applied")` and `listen("cwd-changed")` listeners, the boot sequence, idle animator, LLM setup, onboarding, overlay. These are shared.

**CWD tracking**: Update to set tab name:
```typescript
listen<{ path: string }>("cwd-changed", (event) => {
  const tab = tabManager.getActive();
  if (tab) {
    const basename = event.payload.path.split("/").pop() || event.payload.path;
    tabManager.setTabName(tab.id, basename);
  }
});
```

**Export**: Change `export const domGrid` to `export const tabManager`. Update the export to also expose a helper for backward compat:
```typescript
export const tabManager: TabManager;
/** Helper for code that needs the active grid (backward compat). */
export function getActiveGrid(): DOMGrid | undefined {
  return tabManager.getActive()?.grid;
}
```

This is a large rewrite. The implementer should read the current main.ts carefully and make surgical changes rather than rewriting from scratch. The structure is the same — just routing through `tabManager.getActive()`.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

This will likely have errors in agent/pane.ts and other files that import `domGrid` from main.ts. Those are fixed in Task 6.

- [ ] **Step 3: Commit (even if other files have import errors)**

```bash
git add src/main.ts && git commit -m "feat: rewire main.ts to use TabManager — per-tab routing for all terminal state"
```

---

### Task 6: Adapt Dependent Systems for TabManager

Update agent pane, and any other files that import `domGrid` from main.ts to use the TabManager instead.

**Files:**
- Modify: `src/agent/pane.ts`
- Modify: `src/commands/handlers.ts`

- [ ] **Step 1: Update agent/pane.ts**

Replace all dynamic imports of `domGrid` from `../main` with `tabManager`/`getActiveGrid()`:

In `close()`:
```typescript
import("../main").then(({ tabManager }) => {
  const tab = tabManager.getActive();
  if (tab) {
    const { rows, cols } = tab.grid.measureGrid();
    tab.resize(rows, cols);
  }
}).catch(console.warn);
```

- [ ] **Step 2: Update commands/handlers.ts**

In `handleCursor`, replace:
```typescript
const { domGrid } = await import("../main");
domGrid.setCursorStyle(value as "block" | "beam" | "underline");
```
with:
```typescript
const { tabManager } = await import("../main");
const tab = tabManager.getActive();
if (tab) tab.grid.setCursorStyle(value as "block" | "beam" | "underline");
```

Do this for ALL occurrences of `domGrid` in handlers.ts (the cursor select, cursor direct set, etc.).

- [ ] **Step 3: Search for any remaining domGrid imports**

```bash
cd /Users/hanamori/koji-baseline && grep -rn "domGrid" src/ --include="*.ts"
```

Fix any remaining references.

- [ ] **Step 4: Verify full TypeScript compiles**

```bash
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 5: Verify Rust compiles**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: adapt agent pane and handlers for TabManager"
```

---

## Phase 4: Integration & Build (Task 7)

### Task 7: Final Integration, Version Bump, and Production Build

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src/commands/handlers.ts`

- [ ] **Step 1: Version bump**

`src-tauri/Cargo.toml`: `version = "0.6.0"`
`src-tauri/tauri.conf.json`: `"version": "0.6.0"`
`src/commands/handlers.ts`: `handleVersion()` → `"Kōji Baseline v0.6.0"`

- [ ] **Step 2: Verify both compile**

```bash
cd /Users/hanamori/koji-baseline/src-tauri && cargo check
cd /Users/hanamori/koji-baseline && npx tsc --noEmit
```

- [ ] **Step 3: Production build**

```bash
cd /Users/hanamori/koji-baseline && npm run tauri build
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: Kōji Baseline v0.6.0 — terminal tabs with per-tab PTY, Linked animation, Cmd+T/W shortcuts"
```
