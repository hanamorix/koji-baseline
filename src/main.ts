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

// ── Font system — route to active tab ────────────────────────────────────
fontManager.setChangeCallback((font, size, ligatures) => {
  const tab = tabManager.getActive();
  if (!tab) return;
  tab.grid.setFont(font, size, ligatures);
  const { rows, cols } = tab.grid.measureGrid();
  tab.resize(rows, cols);
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

  // Restore saved model name immediately
  try {
    const saved = await invoke<string>("load_config", { key: "activeModel" });
    if (saved && modelEl) {
      modelEl.textContent = saved;
      // Also set dot to indicate a model is configured
      if (dotEl) dotEl.style.background = "#cc7a00";
    }
  } catch { /* no config yet */ }

  // Check Ollama status and update dot if running
  try {
    const status = await invoke<{ model: string; state: string }>("check_ollama");
    if (modelEl && !modelEl.textContent && status.model) {
      modelEl.textContent = status.model;
    }
    if (dotEl) {
      dotEl.style.background = status.state === "ready" ? "#cc7a00" : "#3a2a10";
    }
  } catch {
    // Ollama not running — dim the dot but keep model name if saved
    if (dotEl && !modelEl?.textContent) dotEl.style.background = "#3a2a10";
  }
}

// Expose onboarding handler for the >> badge onclick in index.html
(window as unknown as Record<string, unknown>)["__kojiLlmOnboard"] = () => {
  llmOnboarding.run().catch(console.error);
};

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
  const tab = tabManager.getActive();
  if (tab) {
    const snap = tab.grid.getLastSnapshot();
    if (snap) tab.grid.render(snap);
  }
}).catch((err) => {
  console.warn("theme-applied listener failed:", err);
});

// ─── Resize observer — grid adapts to window ─────────────────────────────────

let resizeTimer: number | null = null;
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const tab = tabManager.getActive();
    if (!tab) return;
    const { rows, cols } = tab.grid.measureGrid();
    tab.resize(rows, cols);
  }, 50);
}).observe(container);

// ─── Keyboard input ───────────────────────────────────────────────────────────

window.addEventListener("keydown", async (event) => {
  const { key, ctrlKey, metaKey } = event;

  // ── Skip if an input element has focus (agent pane, menu filter, etc.) ──
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    // Only intercept Escape (to close agent pane) — let everything else flow to the input
    if (key === "Escape" && agentPane.isOpen) {
      event.preventDefault();
      agentPane.close();
    }
    return;
  }

  // ── Tab shortcuts ──────────────────────────────────────────────────────
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
  if (metaKey && key >= "1" && key <= "9" && !event.shiftKey) {
    event.preventDefault();
    tabManager.switchToNumber(parseInt(key));
    return;
  }

  // ── Get active tab for all remaining handlers ──────────────────────────
  const tab = tabManager.getActive();
  if (!tab) return;

  // ── Cmd+F — search scrollback ────────────────────────────────────────────
  if (metaKey && key === "f") {
    event.preventDefault();
    tab.search.open();
    return;
  }

  // ── Cmd+K — clear scrollback ───────────────────────────────────────────
  if (metaKey && key === "k") {
    event.preventDefault();
    tab.grid.clearScrollback();
    const clearSeq = "\x1b[2J\x1b[H";
    const bytes = Array.from(new TextEncoder().encode(clearSeq));
    tab.writePty(bytes).catch(console.error);
    return;
  }

  // ── Cmd+A — select all terminal text ──────────────────────────────────
  if (metaKey && key === "a") {
    event.preventDefault();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(tab.grid.getScrollElement());
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return;
  }

  // ── Cmd+V — paste from clipboard with bracketed paste escapes ───────────
  if (metaKey && key === "v") {
    event.preventDefault();
    tab.selection.handlePaste().catch(console.error);
    return;
  }

  // ── Cmd+C — copy selection if present, else send SIGINT (^C) ─────────────
  if (metaKey && key === "c") {
    event.preventDefault();
    tab.selection.handleCopy().then((copied) => {
      if (!copied) {
        // No selection — send ^C (SIGINT)
        tab.writePty([3]).catch(console.error);
      }
    });
    return;
  }

  // ── Escape — close agent pane if open (before passing to PTY) ───────────
  if (key === "Escape" && agentPane.isOpen) {
    event.preventDefault();
    agentPane.close();
    return;
  }

  // ── Ctrl+C / Escape — reset input tracking (shell will show new prompt) ─
  if ((ctrlKey && key === "c") || key === "Escape") {
    tab.currentInput = "";
    tab.autocomplete.hide();
    // Don't return — let it fall through to keyToAnsi to send to PTY
  }

  // ── Autocomplete navigation ──────────────────────────────────────────────
  if (key === "ArrowRight" && tab.autocomplete.getSuggestion()) {
    event.preventDefault();
    const suggestion = tab.autocomplete.accept();
    if (suggestion) {
      const remaining = suggestion.slice(tab.currentInput.length);
      tab.currentInput = suggestion;
      const bytes = Array.from(new TextEncoder().encode(remaining));
      tab.writePty(bytes).catch(console.error);
    }
    return;
  }
  if ((key === "ArrowDown" || key === "ArrowUp") && tab.autocomplete.hasSuggestions()) {
    event.preventDefault();
    tab.autocomplete.navigate(key === "ArrowDown" ? 1 : -1);
    return;
  }

  // Build up the current input line for context tracking
  if (!ctrlKey) {
    if (key === "Enter") {
      tab.autocomplete.hide();
      const line = tab.currentInput.trim();

      if (line.startsWith("/")) {
        // ── Slash command — intercept before PTY ──
        event.preventDefault();
        // Clear the shell's input buffer (Ctrl+U = kill line, Ctrl+C = new prompt)
        tab.writePty([21, 3]).catch(console.error); // \x15 \x03
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
        // ── LLM query — intercept before PTY ──
        event.preventDefault();
        // Clear the shell's input buffer
        tab.writePty([21, 3]).catch(console.error); // \x15 \x03
        overlay.dismiss();

        // Auto-trigger onboarding if no model is configured yet
        const activeModel = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
        let ollamaReady = false;
        try {
          const s = await invoke<{ model: string; state: string }>("check_ollama");
          ollamaReady = s.state === "ready" && !!s.model;
        } catch {
          ollamaReady = false;
        }

        if (!ollamaReady && !activeModel) {
          llmOnboarding.run().catch(console.error);
          tab.currentInput = "";
          return;
        }

        tab.effects.commandSubmit();
        llm.query(line).catch((err) => console.error("llm.query failed:", err));
        tab.currentInput = "";
        return;
      }

      // Regular shell command — record it for context, fire submit effect
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
      // Auto-dismiss overlay when user starts typing a new command
      if (tab.currentInput.length === 1 && overlay.isActive) {
        overlay.dismiss();
      }
    }

    // Update autocomplete ghost text
    tab.autocomplete.update(tab.currentInput);
  }

  // Scroll shortcuts (Shift + navigation keys)
  if (event.shiftKey) {
    if (key === "PageUp") {
      event.preventDefault();
      const scrollEl = tab.grid.getScrollElement();
      scrollEl.scrollBy({ top: -scrollEl.clientHeight, behavior: "smooth" });
      return;
    }
    if (key === "PageDown") {
      event.preventDefault();
      const scrollEl = tab.grid.getScrollElement();
      scrollEl.scrollBy({ top: scrollEl.clientHeight, behavior: "smooth" });
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      tab.grid.getScrollElement().scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (key === "End") {
      event.preventDefault();
      const scrollEl = tab.grid.getScrollElement();
      scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
      return;
    }
  }

  // Font size: Cmd+Plus / Cmd+Minus / Cmd+0 (reset)
  if (metaKey && (key === "=" || key === "+")) {
    event.preventDefault();
    fontManager.incrementSize(1);
    return;
  }
  if (metaKey && key === "-") {
    event.preventDefault();
    fontManager.incrementSize(-1);
    return;
  }
  if (metaKey && key === "0") {
    event.preventDefault();
    fontManager.setSize(14); // reset to default
    return;
  }

  // Alt key routing — if option_as_meta is off, let native handling occur
  if (event.altKey && !optionAsMeta) {
    return; // Let browser handle Option key for special characters
  }

  const seq = keyToAnsi(event);
  if (seq === null) return;

  event.preventDefault();
  const bytes = Array.from(new TextEncoder().encode(seq));
  tab.writePty(bytes).catch((err) => {
    console.error("write_to_session failed:", err);
  });
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
