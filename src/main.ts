// main.ts — Koji terminal frontend
// PTY → engine → event → DOM grid. Keyboard → ANSI → write_to_pty.
// Task 9:  >> prefix routes to Ollama; commandHistory tracks shell I/O for context.
// Task 11: ASCII boot sequence.
// Task 12: Idle animations + transition effects.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DOMGrid } from "./terminal/dom-grid";
import type { GridSnapshot, RenderCell } from "./terminal/dom-grid";
import { initDashboard } from "./dashboard/status-bar";
import { LlmPanel } from "./llm/panel";
import { commandHistory } from "./llm/context";
import { BootSequence } from "./ascii/boot";
import { IdleAnimator } from "./ascii/idle";
import { themeManager } from "./themes/manager";
import { TransitionEffects } from "./animation/effects";
import { dispatchCommand } from "./commands/router";
import type { CommandResult } from "./commands/router";
import { overlay } from "./overlay/overlay";
import { openMenu } from "./overlay/menu";
import type { MenuResult } from "./overlay/menu";
import { agentPane } from "./agent/pane";
import { llmOnboarding } from "./llm/onboarding";
import { SelectionManager } from "./terminal/selection";
import { fontManager } from "./fonts/fonts";

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

// ─── Terminal grid ────────────────────────────────────────────────────────────

export const domGrid = new DOMGrid(container);

// ── Font system ───────────────────────────────────────────────────────────
fontManager.setChangeCallback((font, size, ligatures) => {
  domGrid.setFont(font, size, ligatures);
  // Recalculate grid dimensions after font change
  const { rows, cols } = domGrid.measureGrid();
  domGrid.resize(rows, cols);
  invoke("resize_terminal", { rows, cols });
});

// Load saved font preference
fontManager.loadSaved();

const selection = new SelectionManager(domGrid.getGridElement());
invoke("load_config", { key: "copy_on_select" }).then((val: unknown) => {
  if (val === "false") selection.setCopyOnSelect(false);
}).catch(() => {});
const effects = new TransitionEffects(domGrid.getGridElement());

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

// Check Ollama on startup — update dashboard elements if present
invoke<{ model: string; state: string }>("check_ollama")
  .then((status) => {
    const modelEl = document.getElementById("llm-model");
    const dotEl = document.getElementById("llm-dot");
    if (modelEl) modelEl.textContent = status.model;
    if (dotEl) {
      dotEl.style.background =
        status.state === "ready" ? "#cc7a00" : "#3a2a10";
    }
  })
  .catch(() => {
    // Ollama not running — dashboard stays dim, not a hard failure
    const dotEl = document.getElementById("llm-dot");
    if (dotEl) dotEl.style.background = "#3a2a10";
  });

// Expose onboarding handler for the >> badge onclick in index.html
(window as unknown as Record<string, unknown>)["__kojiLlmOnboard"] = () => {
  llmOnboarding.run().catch(console.error);
};

// ─── CWD tracking — currently unused (clickable regions removed), will return
// let currentCwd = "~";
// listen<{ path: string }>("cwd-changed", (event) => {
//   currentCwd = event.payload.path;
// }).catch((err) => {
//   console.warn("cwd-changed (main) listener failed:", err);
// });

// ─── Theme applied — force grid redraw so colour changes take effect immediately

listen("theme-applied", () => {
  const snap = domGrid.getLastSnapshot();
  if (snap) domGrid.render(snap);
}).catch((err) => {
  console.warn("theme-applied listener failed:", err);
});

// ─── Terminal I/O ─────────────────────────────────────────────────────────────

listen<GridSnapshot>("terminal-output", (event) => {
  domGrid.render(event.payload);
}).catch((err) => {
  console.warn("terminal-output listener failed:", err);
});

listen<RenderCell[][]>("scrollback-append", (event) => {
  domGrid.appendScrollback(event.payload);
}).catch((err) => {
  console.warn("scrollback-append listener failed:", err);
});

// Dynamic initial size based on container dimensions
const { rows: initRows, cols: initCols } = domGrid.measureGrid();
invoke("init_terminal", { rows: initRows, cols: initCols }).catch((err) => {
  console.error("init_terminal failed:", err);
});

// ─── Resize observer — grid adapts to window ─────────────────────────────────

let resizeTimer: number | null = null;
new ResizeObserver(() => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const { rows, cols } = domGrid.measureGrid();
    domGrid.resize(rows, cols);
    invoke("resize_terminal", { rows, cols }).catch(console.warn);
  }, 50);
}).observe(container);

// ─── Keyboard input ───────────────────────────────────────────────────────────

// Track what the user is currently typing so we can capture full commands
let currentInput = "";

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

  // ── Cmd+V — paste from clipboard with bracketed paste escapes ───────────
  if (metaKey && key === "v") {
    event.preventDefault();
    selection.handlePaste().catch(console.error);
    return;
  }

  // ── Cmd+C — copy selection if present, else send SIGINT (^C) ─────────────
  if (metaKey && key === "c") {
    event.preventDefault();
    selection.handleCopy().then((copied) => {
      if (!copied) {
        // No selection — send ^C (SIGINT)
        invoke("write_to_pty", { data: [3] }).catch(console.error);
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

  // Build up the current input line for context tracking
  if (!ctrlKey) {
    if (key === "Enter") {
      const line = currentInput.trim();

      if (line.startsWith("/")) {
        // ── Slash command — intercept before PTY ──
        event.preventDefault();
        effects.commandSubmit();
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
        currentInput = "";
        return;
      }

      if (line.startsWith(">>")) {
        // ── LLM query — don't send to PTY ──
        event.preventDefault();
        overlay.dismiss(); // clear any previous overlay

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
          currentInput = "";
          return;
        }

        effects.commandSubmit();
        llm.query(line).catch((err) => console.error("llm.query failed:", err));
        currentInput = "";
        return;
      }

      // Regular shell command — record it for context, fire submit effect
      if (line.length > 0) {
        commandHistory.addCommand(line);
        effects.commandSubmit();
      }
      currentInput = "";
    } else if (key === "Backspace") {
      currentInput = currentInput.slice(0, -1);
    } else if (key.length === 1) {
      currentInput += key;
      // Auto-dismiss overlay when user starts typing a new command
      if (currentInput.length === 1 && overlay.isActive) {
        overlay.dismiss();
      }
    }
  }

  // Scroll shortcuts (Shift + navigation keys)
  if (event.shiftKey) {
    if (key === "PageUp") {
      event.preventDefault();
      const scrollEl = domGrid.getScrollElement();
      scrollEl.scrollBy({ top: -scrollEl.clientHeight, behavior: "smooth" });
      return;
    }
    if (key === "PageDown") {
      event.preventDefault();
      const scrollEl = domGrid.getScrollElement();
      scrollEl.scrollBy({ top: scrollEl.clientHeight, behavior: "smooth" });
      return;
    }
    if (key === "Home") {
      event.preventDefault();
      domGrid.getScrollElement().scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (key === "End") {
      event.preventDefault();
      const scrollEl = domGrid.getScrollElement();
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

  const seq = keyToAnsi(event);
  if (seq === null) return;

  event.preventDefault();
  const bytes = Array.from(new TextEncoder().encode(seq));
  invoke("write_to_pty", { data: bytes }).catch((err) => {
    console.error("write_to_pty failed:", err);
  });
});

// ─── keyToAnsi ────────────────────────────────────────────────────────────────

function keyToAnsi(event: KeyboardEvent): string | null {
  const { key, ctrlKey } = event;

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
