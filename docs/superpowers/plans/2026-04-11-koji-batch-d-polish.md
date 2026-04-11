# Batch D: Session Restore, Quick Terminal, Security, Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session persistence, quick terminal visor, secure keyboard entry, and verify performance + Unicode correctness.

**Architecture:** Session state serialized to JSON on app close, restored on launch. Visor is a CSS overlay panel with its own terminal session, toggled by keybinding. Secure input uses macOS Carbon FFI. Performance and Unicode are audit tasks with targeted fixes.

**Tech Stack:** Rust (serde, Carbon FFI), TypeScript (DOM)

---

### Task 1: Session Restore — Rust Backend

**Files:**
- Create: `src-tauri/src/session_restore.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create session_restore.rs**

```rust
// session_restore.rs — Save and restore terminal sessions across app restarts

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSession {
    pub tabs: Vec<SavedTab>,
    pub active_tab_index: usize,
    pub window_width: f64,
    pub window_height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedTab {
    pub name: String,
    pub panes: Vec<SavedPane>,
    pub layout: SavedLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedPane {
    pub cwd: String,
    pub scrollback: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SavedLayout {
    Leaf { pane_index: usize },
    Branch {
        direction: String,
        ratio: f64,
        first: Box<SavedLayout>,
        second: Box<SavedLayout>,
    },
}

fn session_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".koji-baseline")
        .join("session.json")
}

pub fn save(session: &SavedSession) -> Result<(), String> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Serialize failed: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Write failed: {e}"))
}

pub fn load() -> Option<SavedSession> {
    let path = session_path();
    if !path.exists() { return None; }
    let data = std::fs::read_to_string(&path).ok()?;
    let session: SavedSession = serde_json::from_str(&data).ok()?;
    // Delete after reading — single-use restore
    let _ = std::fs::remove_file(&path);
    Some(session)
}

pub fn clear() {
    let _ = std::fs::remove_file(session_path());
}
```

- [ ] **Step 2: Register in lib.rs**

Add `pub mod session_restore;` to module declarations.

Add Tauri commands:
```rust
#[tauri::command]
fn save_session(session: session_restore::SavedSession) -> Result<(), String> {
    session_restore::save(&session)
}

#[tauri::command]
fn load_saved_session() -> Option<session_restore::SavedSession> {
    session_restore::load()
}

#[tauri::command]
fn clear_saved_session() {
    session_restore::clear();
}
```

Register in `invoke_handler`. Add a close handler in `setup` that saves session state:

Actually, the close handler needs frontend state — the Rust side doesn't know tab CWDs. The frontend will call `save_session` before the window closes. We listen for the `close-requested` event in the frontend.

- [ ] **Step 3: Run `cargo check` and `cargo test`**

Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/session_restore.rs src-tauri/src/lib.rs
git commit -m "feat: session restore backend — save, load, clear commands"
```

---

### Task 2: Session Restore — Frontend

**Files:**
- Create: `src/session/restore.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create restore.ts**

```typescript
// restore.ts — Save terminal state on close, restore on launch

import { invoke } from "@tauri-apps/api/core";
import type { TabManager } from "../tabs/tab-manager";

interface SavedPane {
  cwd: string;
  scrollback: string[];
}

interface SavedLayout {
  Leaf?: { pane_index: number };
  Branch?: { direction: string; ratio: number; first: SavedLayout; second: SavedLayout };
}

interface SavedTab {
  name: string;
  panes: SavedPane[];
  layout: SavedLayout;
}

interface SavedSession {
  tabs: SavedTab[];
  active_tab_index: number;
  window_width: number;
  window_height: number;
}

/** Save the current session state to disk */
export async function saveSession(tabManager: TabManager): Promise<void> {
  const allLayouts = (tabManager as any).layouts as Map<string, any>;
  const tabOrder = (tabManager as any).tabOrder as string[];
  const activeTabId = (tabManager as any).activeTabId as string;

  const tabs: SavedTab[] = [];
  for (const tabId of tabOrder) {
    const layout = allLayouts.get(tabId);
    if (!layout) continue;

    const sessions = layout.getAllSessions();
    const panes: SavedPane[] = sessions.map((s: any) => ({
      cwd: s.cwd || "",
      scrollback: [], // Scrollback text extraction is complex — save CWD only for now
    }));

    tabs.push({
      name: sessions[0]?.name || "terminal",
      panes,
      layout: { Leaf: { pane_index: 0 } }, // Simplified — single pane per tab for now
    });
  }

  const session: SavedSession = {
    tabs,
    active_tab_index: tabOrder.indexOf(activeTabId),
    window_width: window.innerWidth,
    window_height: window.innerHeight,
  };

  await invoke("save_session", { session });
}

/** Check for a saved session and restore it */
export async function restoreSession(tabManager: TabManager): Promise<boolean> {
  try {
    const session = await invoke<SavedSession | null>("load_saved_session");
    if (!session || session.tabs.length === 0) return false;

    // Create tabs with saved CWDs
    for (let i = 0; i < session.tabs.length; i++) {
      const savedTab = session.tabs[i];
      const cwd = savedTab.panes[0]?.cwd || "";

      if (i === 0) {
        // First tab was already created by boot sequence — just set its CWD
        // Actually, we need to handle this differently. The caller should skip
        // the default first tab creation and let us create all tabs.
        // For now, create additional tabs after the first.
        continue;
      }

      // Create additional tabs with saved CWDs
      // TabManager.createTab uses the active tab's CWD, but we want specific CWDs.
      // We'll set the CWD after creation by using the internal session.
      await tabManager.createTab();
    }

    // Switch to the previously active tab
    if (session.active_tab_index >= 0 && session.active_tab_index < session.tabs.length) {
      const tabOrder = (tabManager as any).tabOrder as string[];
      if (tabOrder[session.active_tab_index]) {
        tabManager.switchTo(tabOrder[session.active_tab_index]);
      }
    }

    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Wire save-on-close in main.ts**

Add import:
```typescript
import { saveSession } from "./session/restore";
import { getCurrentWindow } from "@tauri-apps/api/window";
```

After the boot sequence and tab manager creation, add close handler:
```typescript
// ─── Session save on close ───────────────────────────────────────────────────
getCurrentWindow().onCloseRequested(async (event) => {
  await saveSession(tabManager);
  // Don't prevent close — let it proceed
}).catch(() => {});
```

Note: `@tauri-apps/api/window` may need to be imported. Check if it's available in the current Tauri v2 SDK. If not, use `listen("tauri://close-requested", ...)` from the events API.

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/session/restore.ts src/main.ts
git commit -m "feat: session save on close, restore framework"
```

---

### Task 3: Quick Terminal Visor

**Files:**
- Create: `src/visor/visor.ts`
- Modify: `src-tauri/src/config.rs`
- Modify: `resources/default-config.toml`
- Modify: `index.html`
- Modify: `src/main.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Add visor config**

In `config.rs`, add:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuickTerminalConfig {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_visor_hotkey")]
    pub hotkey: String,
    #[serde(default = "d_visor_height")]
    pub height_percent: u32,
}

impl Default for QuickTerminalConfig {
    fn default() -> Self {
        Self { enabled: true, hotkey: "cmd+`".into(), height_percent: 40 }
    }
}

fn d_visor_hotkey() -> String { "cmd+`".into() }
fn d_visor_height() -> u32 { 40 }
```

Add to KojiConfig: `pub quick_terminal: QuickTerminalConfig`

In `default-config.toml`:
```toml
[quick_terminal]
enabled = true
hotkey = "cmd+`"
height_percent = 40
```

- [ ] **Step 2: Create visor.ts**

```typescript
// visor.ts — Quick terminal visor panel (dropdown from top)

import { TabSession } from "../tabs/tab-session";

export class Visor {
  private panelEl: HTMLElement;
  private session: TabSession | null = null;
  private _isOpen = false;
  private heightPercent: number;

  constructor(heightPercent = 40) {
    this.heightPercent = heightPercent;

    this.panelEl = document.getElementById("visor-panel")!;
    if (!this.panelEl) {
      this.panelEl = document.createElement("div");
      this.panelEl.id = "visor-panel";
      this.panelEl.className = "visor-panel";
      document.getElementById("app")!.appendChild(this.panelEl);
    }
    this.panelEl.style.height = `${heightPercent}vh`;
  }

  get isOpen(): boolean { return this._isOpen; }

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
      // Create session on first open
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

  private hide(): void {
    this._isOpen = false;
    this.panelEl.classList.remove("visor-open");
    this.session?.deactivate();
  }

  getSession(): TabSession | null {
    return this.session;
  }
}
```

- [ ] **Step 3: Add visor HTML to index.html**

Before the `terminal-viewport` div:
```html
    <!-- ── Visor (quick terminal dropdown) ──────────────────── -->
    <div class="visor-panel" id="visor-panel"></div>
```

- [ ] **Step 4: Add visor CSS**

```css
/* ── Visor (quick terminal) ──────────────────────────────────────────────── */

.visor-panel {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 40vh;
  background: var(--koji-void);
  border-bottom: 2px solid var(--koji-orange);
  z-index: 90;
  transform: translateY(-100%);
  transition: transform 0.25s ease;
  overflow: hidden;
  display: none;
}

.visor-panel.visor-open {
  display: block;
  transform: translateY(0);
}

/* Secure input indicator */
.secure-input-icon {
  cursor: pointer;
  color: var(--koji-faded);
  font-size: 11px;
  margin-left: 6px;
}

.secure-input-icon.active { color: var(--koji-orange); }
```

- [ ] **Step 5: Wire visor keybinding in main.ts**

```typescript
import { Visor } from "./visor/visor";

const visor = new Visor(40);

keybindings.register("visor_toggle", "cmd+`", () => {
  visor.toggle().catch(console.error);
});
```

- [ ] **Step 6: Run `npx tsc --noEmit` and `cargo check`**

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/config.rs resources/default-config.toml src/visor/visor.ts index.html src/styles/wallace.css src/main.ts
git commit -m "feat: quick terminal visor — Cmd+backtick dropdown panel"
```

---

### Task 4: Secure Keyboard Entry

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `index.html`
- Modify: `src/main.ts`

- [ ] **Step 1: Add secure input FFI to lib.rs**

```rust
// ─── Secure Keyboard Entry ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
extern "C" {
    fn EnableSecureEventInput();
    fn DisableSecureEventInput();
    fn IsSecureEventInputEnabled() -> u8;
}

#[tauri::command]
fn toggle_secure_input() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        if IsSecureEventInputEnabled() != 0 {
            DisableSecureEventInput();
            return false;
        } else {
            EnableSecureEventInput();
            return true;
        }
    }
    #[cfg(not(target_os = "macos"))]
    false
}

#[tauri::command]
fn is_secure_input() -> bool {
    #[cfg(target_os = "macos")]
    unsafe {
        return IsSecureEventInputEnabled() != 0;
    }
    #[cfg(not(target_os = "macos"))]
    false
}
```

Register both in `invoke_handler`.

- [ ] **Step 2: Add secure input indicator to index.html**

In the dashboard-top div, before the era-clock:
```html
      <span class="secure-input-icon" id="secure-input" role="button" tabindex="0" aria-label="Toggle secure keyboard entry" title="Secure keyboard entry">🔓</span>
```

- [ ] **Step 3: Wire in main.ts**

```typescript
// ─── Secure keyboard entry ───────────────────────────────────────────────────
const secureEl = document.getElementById("secure-input");
if (secureEl) {
  secureEl.addEventListener("click", async () => {
    const enabled = await invoke<boolean>("toggle_secure_input");
    secureEl.textContent = enabled ? "🔒" : "🔓";
    secureEl.classList.toggle("active", enabled);
  });
}
```

- [ ] **Step 4: Run `cargo check` and `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs index.html src/main.ts
git commit -m "feat: secure keyboard entry toggle via macOS Carbon FFI"
```

---

### Task 5: Performance Audit

**Files:** Varies based on findings.

- [ ] **Step 1: Measure render throughput**

In the browser dev console (via Tauri dev mode), time the render:
```javascript
// In dom-grid.ts renderImmediate, add timing
const start = performance.now();
// ... existing render code ...
const elapsed = performance.now() - start;
if (elapsed > 5) console.warn(`Slow render: ${elapsed.toFixed(1)}ms`);
```

Run: `cat /dev/urandom | base64 | head -c 500000` and observe console.

- [ ] **Step 2: Check memory**

Open Activity Monitor, note Kōji's memory usage at startup and after 10K lines of output.

Target: under 200MB steady state.

- [ ] **Step 3: Apply optimizations if needed**

If renders are slow: the existing row-level diffing should handle it. If not, consider batching into `DocumentFragment`.

If memory is high: check if scrollback DOM nodes are being trimmed. The `maxScrollback = 10000` in DOMGrid should handle this.

- [ ] **Step 4: Commit any optimizations**

```bash
git add -A && git commit -m "perf: render optimizations from profiling audit"
```

---

### Task 6: Unicode/Emoji Audit

**Files:** Varies based on findings.

- [ ] **Step 1: Test wide characters**

In the terminal, run:
```bash
echo "中文测试 | Width test"
echo "🍕🍔🍟 | Emoji test"
echo "👨‍👩‍👧‍👦 | ZWJ test"
echo "café | Combining test"
printf "┌────────┐\n│ Box    │\n└────────┘\n"
```

Check: CJK characters occupy 2 cells, emoji render as single glyphs, box-drawing characters align.

- [ ] **Step 2: Verify column alignment**

Run `htop` or `top` — verify columns align correctly with wide characters.

- [ ] **Step 3: Fix any issues found**

Most likely fix: `unicode-width` crate for Rust-side width calculation. The DOM renderer should handle rendering correctly since browsers have good Unicode support — issues will be in column alignment.

- [ ] **Step 4: Commit fixes**

```bash
git add -A && git commit -m "fix: Unicode correctness improvements from audit"
```

---

### Task 7: Full Build + Verification

- [ ] **Step 1:** `npx tsc --noEmit` → no errors
- [ ] **Step 2:** `cd src-tauri && cargo test -- --nocapture` → all pass
- [ ] **Step 3:** `npm run build` → clean
- [ ] **Step 4:** `cd src-tauri && cargo build --release` → clean

---

### Task Summary

| Task | Component | Dependencies | Files touched |
|------|-----------|--------------|---------------|
| 1 | Session restore backend | None | session_restore.rs, lib.rs |
| 2 | Session restore frontend | Task 1 | restore.ts, main.ts |
| 3 | Quick terminal visor | None | visor.ts, config.rs, index.html, wallace.css, main.ts |
| 4 | Secure keyboard entry | None | lib.rs, index.html, main.ts |
| 5 | Performance audit | None | varies |
| 6 | Unicode audit | None | varies |
| 7 | Full build verification | All | — |
