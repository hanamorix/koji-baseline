// main.ts — Kōji terminal frontend
// Multi-tab terminal: TabManager owns per-tab PTY sessions.
// >> prefix routes to LLM, / prefix routes to slash commands.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initDashboard } from "./dashboard/status-bar";
import { LlmPanel } from "./llm/panel";
import { commandHistory } from "./llm/context";
import { BootSequence } from "./ascii/boot";
import { IdleAnimator } from "./ascii/idle";
import { themeManager } from "./themes/manager";
import { dispatchCommand } from "./commands/router";
import type { CommandResult } from "./commands/router";
import { overlay } from "./overlay/overlay";
import { openMenu } from "./overlay/menu";
import type { MenuResult } from "./overlay/menu";
import { agentPane } from "./agent/pane";
import { llmOnboarding } from "./llm/onboarding";
import { fontManager } from "./fonts/fonts";
import { TabManager } from "./tabs/tab-manager";
import { KeybindingManager } from "./config/keybindings";
import { openPalette, isPaletteOpen } from "./config/palette";

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Load saved theme before anything renders — colours need to be right on first paint.
await themeManager.loadSaved();

initDashboard();

const container = document.getElementById("terminal-container");
if (!container) throw new Error("#terminal-container not found");

// ─── ASCII Boot Sequence ──────────────────────────────────────────────────────

const bootCanvas = document.createElement("canvas");
const bootDpr = window.devicePixelRatio || 1;
bootCanvas.width  = container.clientWidth * bootDpr;
bootCanvas.height = container.clientHeight * bootDpr;
bootCanvas.style.width  = `${container.clientWidth}px`;
bootCanvas.style.height = `${container.clientHeight}px`;
bootCanvas.style.display = "block";
container.appendChild(bootCanvas);

const boot = new BootSequence(bootCanvas);
await boot.play();
container.removeChild(bootCanvas);

// ─── Tab Manager ─────────────────────────────────────────────────────────────
export const tabManager = new TabManager(container);
await tabManager.createTab();

// ─── Keybinding system ───────────────────────────────────────────────────────

const keybindings = new KeybindingManager();

// Register all actions with default combos
keybindings.register("new_tab", "cmd+t", () => { tabManager.createTab().catch(console.error); });
keybindings.register("close_tab", "cmd+w", () => tabManager.closeActiveTab());
keybindings.register("next_tab", "cmd+shift+]", () => tabManager.nextTab());
keybindings.register("prev_tab", "cmd+shift+[", () => tabManager.prevTab());
keybindings.register("palette", "cmd+shift+p", () => openPalette(keybindings));
keybindings.register("search", "cmd+f", () => { tabManager.getActive()?.search.open(); });
keybindings.register("clear", "cmd+k", () => {
  const t = tabManager.getActive();
  if (t) { t.grid.clearScrollback(); t.writePty(Array.from(new TextEncoder().encode("\x1b[2J\x1b[H"))).catch(console.error); }
});
keybindings.register("zone_up", "cmd+up", () => { tabManager.getActive()?.jumpToPreviousZone(); });
keybindings.register("zone_down", "cmd+down", () => { tabManager.getActive()?.jumpToNextZone(); });
keybindings.register("select_all", "cmd+a", () => {
  const t = tabManager.getActive();
  if (t) { const sel = window.getSelection(); if (sel) { const r = document.createRange(); r.selectNodeContents(t.grid.getScrollElement()); sel.removeAllRanges(); sel.addRange(r); } }
});
keybindings.register("paste", "cmd+v", () => { tabManager.getActive()?.selection.handlePaste().catch(console.error); });
keybindings.register("copy", "cmd+c", () => {
  const t = tabManager.getActive();
  if (t) t.selection.handleCopy().then((copied) => { if (!copied) t.writePty([3]).catch(console.error); });
});
keybindings.register("font_up", "cmd+=", () => fontManager.incrementSize(1));
keybindings.register("font_down", "cmd+-", () => fontManager.incrementSize(-1));
keybindings.register("font_reset", "cmd+0", () => fontManager.setSize(14));
keybindings.register("split_right", "cmd+d", () => { tabManager.splitActivePane("horizontal").catch(console.error); });
keybindings.register("split_down", "cmd+shift+d", () => { tabManager.splitActivePane("vertical").catch(console.error); });
keybindings.register("close_pane", "cmd+shift+w", () => tabManager.closeActivePane());
keybindings.register("pane_left", "cmd+option+left", () => tabManager.focusPaneDirection("left"));
keybindings.register("pane_right", "cmd+option+right", () => tabManager.focusPaneDirection("right"));
keybindings.register("pane_up", "cmd+option+up", () => tabManager.focusPaneDirection("up"));
keybindings.register("pane_down", "cmd+option+down", () => tabManager.focusPaneDirection("down"));
keybindings.register("pane_zoom", "cmd+shift+enter", () => tabManager.togglePaneZoom());

// Load TOML config and update keybindings
invoke("load_toml_config").then((config: unknown) => {
  const cfg = config as { keybindings?: Record<string, string> };
  if (cfg.keybindings) keybindings.updateFromConfig(cfg.keybindings);
}).catch(() => {});

// Hot reload: update keybindings when config changes
listen("config-changed", (event: any) => {
  if (event.payload?.keybindings) {
    keybindings.updateFromConfig(event.payload.keybindings);
  }
}).catch(() => {});

// ── Font system — route to active tab ────────────────────────────────────
fontManager.setChangeCallback((font, size, ligatures) => {
  for (const session of tabManager.getAllTabs()) {
    session.grid.setFont(font, size, ligatures);
  }
  const active = tabManager.getActive();
  if (active) {
    const { rows, cols } = active.grid.measureGrid();
    active.resize(rows, cols);
  }
});

// Load saved font preference
fontManager.loadSaved();

// ── Config loading (shared) ──────────────────────────────────────────────
invoke("load_config", { key: "copy_on_select" }).then((val: unknown) => {
  const tab = tabManager.getActive();
  if (tab && val === "false") tab.selection.setCopyOnSelect(false);
}).catch(() => {});
invoke("load_config", { key: "cursor_style" }).then((val: unknown) => {
  const tab = tabManager.getActive();
  if (tab && (val === "beam" || val === "underline")) {
    tab.grid.setCursorStyle(val as "beam" | "underline");
  }
}).catch(() => {});

let optionAsMeta = true;
invoke("load_config", { key: "option_as_meta" }).then((val: unknown) => {
  if (val === "false") optionAsMeta = false;
}).catch(() => {});

// ── Idle animator (kanji cycling only, no canvas) ──────────────────────────
const idle = new IdleAnimator();
idle.onStateChange((isIdle, kanji) => {
  const el = document.getElementById("idle-icon");
  if (el) {
    el.textContent = isIdle && kanji ? kanji : "";
  }
});
idle.start();

// ─── LLM setup ───────────────────────────────────────────────────────────────

const llm = new LlmPanel();

// Wire streaming response into the DOM overlay (replaces Canvas painting)
llm.onResponseUpdate((text, done) => {
  overlay.updateStreaming(text, done);
});

// Load saved model and check Ollama on startup — update dashboard badge
{
  const modelEl = document.getElementById("llm-model");
  const dotEl = document.getElementById("llm-dot");

  const getVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Restore saved model name immediately
  try {
    const saved = await invoke<string>("load_config", { key: "activeModel" });
    if (saved && modelEl) {
      modelEl.textContent = saved;
      if (dotEl) dotEl.style.background = getVar("--koji-warm");
    }
  } catch { /* no config yet */ }

  // Check Ollama status and update dot if running
  try {
    const status = await invoke<{ model: string; state: string }>("check_ollama");
    if (modelEl && !modelEl.textContent && status.model) {
      modelEl.textContent = status.model;
    }
    if (dotEl) {
      dotEl.style.background = status.state === "ready" ? getVar("--koji-warm") : getVar("--koji-deep");
    }
  } catch {
    if (dotEl && !modelEl?.textContent) dotEl.style.background = getVar("--koji-deep");
  }
}

// Wire the LLM badge click handler (CSP blocks inline onclick)
const llmBadge = document.getElementById("llm-badge");
if (llmBadge) {
  const launchOnboarding = () => llmOnboarding.run().catch(console.error);
  llmBadge.addEventListener("click", launchOnboarding);
  llmBadge.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); launchOnboarding(); }
  });
}

// ─── CWD tracking — update active tab name ───────────────────────────────────
listen<{ path: string }>("cwd-changed", (event) => {
  const tab = tabManager.getActive();
  if (tab) {
    const basename = event.payload.path.split("/").pop() || event.payload.path;
    tabManager.setTabName(tab.id, basename);
  }
}).catch(() => {});

// ─── Theme applied — force grid redraw so colour changes take effect immediately

listen("theme-applied", () => {
  // Force full re-render of ALL tabs — inline styles have stale colors
  for (const tab of tabManager.getAllTabs()) {
    tab.grid.invalidateAllRows();
    const snap = tab.grid.getLastSnapshot();
    if (snap) tab.grid.render(snap);
  }
}).catch((err) => {
  console.warn("theme-applied listener failed:", err);
});

// ─── Long-running command notification ───────────────────────────────────────

listen<{ exit_code: number | null; duration_seconds: number }>("notify-command-complete", (event) => {
  if (document.hasFocus()) return;
  const { exit_code, duration_seconds } = event.payload;
  const status = exit_code === 0 ? "completed" : `failed (exit ${exit_code})`;
  if (Notification.permission === "granted") {
    new Notification("Kōji Baseline", { body: `Command ${status} after ${duration_seconds}s` });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") {
        new Notification("Kōji Baseline", { body: `Command ${status} after ${duration_seconds}s` });
      }
    });
  }
}).catch(() => {});

// ─── Resize observer — grid adapts to window ─────────────────────────────────

let resizeTimer: number | null = null;
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const session of tabManager.getAllTabs()) {
      if (session.active) {
        const { rows, cols } = session.grid.measureGrid();
        session.resize(rows, cols);
      }
    }
  }, 50);
}).observe(container);

// ─── Keyboard input ───────────────────────────────────────────────────────────

window.addEventListener("keydown", async (event) => {
  const { key, ctrlKey, metaKey } = event;

  // Skip if input/textarea focused (except Escape for agent pane)
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    if (key === "Escape" && agentPane.isOpen) { event.preventDefault(); agentPane.close(); }
    return;
  }

  // Command palette is open — let it handle all keys
  if (isPaletteOpen()) return;

  // Cmd+1-9 for tab switching (dynamic, not in keybinding system)
  if (metaKey && key >= "1" && key <= "9" && !event.shiftKey) {
    event.preventDefault();
    tabManager.switchToNumber(parseInt(key));
    return;
  }

  // Try keybinding system first
  if (keybindings.handleKeyEvent(event)) return;

  // Get active tab for remaining handlers
  const tab = tabManager.getActive();
  if (!tab) return;

  // Escape — close agent pane if open
  if (key === "Escape" && agentPane.isOpen) { event.preventDefault(); agentPane.close(); return; }

  // Ctrl+C / Escape — reset input tracking
  if ((ctrlKey && key === "c") || key === "Escape") {
    tab.currentInput = "";
    tab.autocomplete.hide();
  }

  // Autocomplete navigation
  if (key === "ArrowRight" && tab.autocomplete.getSuggestion()) {
    event.preventDefault();
    const suggestion = tab.autocomplete.accept();
    if (suggestion) {
      const remaining = suggestion.slice(tab.currentInput.length);
      tab.currentInput = suggestion;
      tab.writePty(Array.from(new TextEncoder().encode(remaining))).catch(console.error);
    }
    return;
  }
  if ((key === "ArrowDown" || key === "ArrowUp") && tab.autocomplete.hasSuggestions()) {
    event.preventDefault();
    tab.autocomplete.navigate(key === "ArrowDown" ? 1 : -1);
    return;
  }

  // Input line tracking + slash commands + LLM queries
  if (!ctrlKey) {
    if (key === "Enter") {
      tab.autocomplete.hide();
      const line = tab.currentInput.trim();

      if (line.startsWith("/")) {
        event.preventDefault();
        tab.writePty([21, 3]).catch(console.error);
        tab.effects.commandSubmit();
        const result = dispatchCommand(line);
        if (result) {
          const res = await result;
          if ("type" in res && (res as MenuResult).type === "menu") {
            openMenu(res as MenuResult);
          } else {
            const cmd = res as CommandResult;
            overlay.showMessage(cmd.output, cmd.isError);
          }
        }
        tab.currentInput = "";
        return;
      }

      if (line.startsWith(">>")) {
        event.preventDefault();
        tab.writePty([21, 3]).catch(console.error);
        overlay.dismiss();
        const activeModel = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
        let ollamaReady = false;
        try {
          const s = await invoke<{ model: string; state: string }>("check_ollama");
          ollamaReady = s.state === "ready" && !!s.model;
        } catch { ollamaReady = false; }
        if (!ollamaReady && !activeModel) {
          llmOnboarding.run().catch(console.error);
          tab.currentInput = "";
          return;
        }
        tab.effects.commandSubmit();
        llm.query(line).catch(console.error);
        tab.currentInput = "";
        return;
      }

      if (line.length > 0) {
        commandHistory.addCommand(line);
        tab.autocomplete.addToHistory(line);
        tab.effects.commandSubmit();
      }
      tab.currentInput = "";
    } else if (key === "Backspace") {
      tab.currentInput = tab.currentInput.slice(0, -1);
    } else if (key.length === 1) {
      tab.currentInput += key;
      if (tab.currentInput.length === 1 && overlay.isActive) overlay.dismiss();
    }
    tab.autocomplete.update(tab.currentInput);
  }

  // Scroll shortcuts
  if (event.shiftKey) {
    if (key === "PageUp") { event.preventDefault(); const s = tab.grid.getScrollElement(); s.scrollBy({ top: -s.clientHeight, behavior: "smooth" }); return; }
    if (key === "PageDown") { event.preventDefault(); const s = tab.grid.getScrollElement(); s.scrollBy({ top: s.clientHeight, behavior: "smooth" }); return; }
    if (key === "Home") { event.preventDefault(); tab.grid.getScrollElement().scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (key === "End") { event.preventDefault(); const s = tab.grid.getScrollElement(); s.scrollTo({ top: s.scrollHeight, behavior: "smooth" }); return; }
  }

  // Alt key routing
  if (event.altKey && !optionAsMeta) return;

  const seq = keyToAnsi(event);
  if (seq === null) return;
  event.preventDefault();
  tab.writePty(Array.from(new TextEncoder().encode(seq))).catch(console.error);
});

// ─── keyToAnsi ────────────────────────────────────────────────────────────────

function keyToAnsi(event: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey } = event;

  // Alt/Option as Meta — send ESC prefix + key
  if (altKey && !ctrlKey && !event.metaKey) {
    if (key === "Backspace") return "\x1b\x7f"; // Meta-Backspace = delete word back
    if (key.length === 1) {
      // Use raw key letter, not composed character (macOS Option produces special chars)
      const rawKey = event.code.startsWith("Key") ? event.code.slice(3).toLowerCase() : key;
      return "\x1b" + rawKey;
    }
  }

  // Ctrl+key combos (control characters)
  if (ctrlKey && key.length === 1) {
    const code = key.toLowerCase().charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) {
      return String.fromCharCode(code);
    }
  }

  switch (key) {
    case "Enter":       return "\r";
    case "Backspace":   return "\x7f";
    case "Tab":         return "\t";
    case "Escape":      return "\x1b";
    case "ArrowUp":     return "\x1b[A";
    case "ArrowDown":   return "\x1b[B";
    case "ArrowRight":  return "\x1b[C";
    case "ArrowLeft":   return "\x1b[D";
    case "Home":        return "\x1b[H";
    case "End":         return "\x1b[F";
    case "Delete":      return "\x1b[3~";
    case "Insert":      return "\x1b[2~";
    case "PageUp":      return "\x1b[5~";
    case "PageDown":    return "\x1b[6~";
    case "F1":          return "\x1bOP";
    case "F2":          return "\x1bOQ";
    case "F3":          return "\x1bOR";
    case "F4":          return "\x1bOS";
    case "F5":          return "\x1b[15~";
    case "F6":          return "\x1b[17~";
    case "F7":          return "\x1b[18~";
    case "F8":          return "\x1b[19~";
    case "F9":          return "\x1b[20~";
    case "F10":         return "\x1b[21~";
    case "F11":         return "\x1b[23~";
    case "F12":         return "\x1b[24~";
    default:
      if (key.length === 1 && !ctrlKey) return key;
      return null;
  }
}

// ─── Provider config helper ───────────────────────────────────────────────────

/**
 * Read active provider/model/autorun from ~/.koji-baseline/config.json.
 * Exported so command handlers (e.g. /llm provider) can use it.
 */
export async function loadProviderConfig(): Promise<{
  provider: string;
  model: string;
  autorun: string;
}> {
  const provider = await invoke<string>("load_config", { key: "activeProvider" }).catch(() => "");
  const model    = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
  const autorun  = await invoke<string>("load_config", { key: "autorun" }).catch(() => "");
  return {
    provider: provider || "ollama",
    model:    model    || "",
    autorun:  autorun  || "off",
  };
}
