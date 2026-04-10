// main.ts — Koji terminal frontend
// PTY → engine → event → Canvas. Keyboard → ANSI → write_to_pty.
// Task 9:  >> prefix routes to Ollama; commandHistory tracks shell I/O for context.
// Task 11: ASCII boot sequence.
// Task 12: Idle animations + transition effects.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalGrid, GridSnapshot } from "./terminal/grid";
import { detectClickableRegions, findRegionAt } from "./terminal/clickable";
import { initDashboard } from "./dashboard/status-bar";
import { WaveformAnimator } from "./animation/waveform";
import { LlmPanel } from "./llm/panel";
import { commandHistory } from "./llm/context";
import { BootSequence } from "./ascii/boot";
import { IdleAnimator } from "./ascii/idle";
import { TransitionEffects } from "./animation/effects";
import { themeManager } from "./themes/manager";
import { dispatchCommand } from "./commands/router";
import { overlay } from "./overlay/overlay";

// ─── Boot ─────────────────────────────────────────────────────────────────────

// Load saved theme before anything renders — colours need to be right on first paint.
await themeManager.loadSaved();

initDashboard();

const waveform = new WaveformAnimator("waveform-top", "waveform-bottom");
waveform.start();

listen<{ cpu_percent: number }>("system-stats", (event) => {
  waveform.setCpuPercent(event.payload.cpu_percent);
}).catch((err) => {
  console.warn("waveform system-stats listener failed:", err);
});

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

const grid = new TerminalGrid(container);

// ─── Idle animator ────────────────────────────────────────────────────────────

const idleAnimator = new IdleAnimator();

// Feed the terminal canvas to the idle animator once the grid exposes it.
// TerminalGrid renders to a <canvas> it owns inside `container`.
const termCanvas = container.querySelector("canvas");
if (termCanvas) idleAnimator.setCanvas(termCanvas as HTMLCanvasElement);

// Kanji icon — status bar element id: "idle-icon" (added by status-bar if present)
idleAnimator.onStateChange((idle) => {
  const iconEl = document.getElementById("idle-icon");
  if (!iconEl) return;
  iconEl.textContent = idle ? idleAnimator.getCurrentKanji() : "光";
});

idleAnimator.start();

// ─── Transition effects ───────────────────────────────────────────────────────

let effects: TransitionEffects | null = null;
const effectCanvas = container.querySelector("canvas");
if (effectCanvas) {
  effects = new TransitionEffects(effectCanvas as HTMLCanvasElement);
}

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

// ─── CWD tracking — updated by the same "cwd-changed" event the status bar uses

let currentCwd = "~";
listen<{ path: string }>("cwd-changed", (event) => {
  currentCwd = event.payload.path;
}).catch((err) => {
  console.warn("cwd-changed (main) listener failed:", err);
});

// ─── Terminal I/O ─────────────────────────────────────────────────────────────

let clickableTimer = 0;

listen<GridSnapshot>("terminal-output", (event) => {
  grid.render(event.payload);

  // Debounce region detection — scan 200 ms after the last output burst
  clearTimeout(clickableTimer);
  clickableTimer = window.setTimeout(async () => {
    const regions = await detectClickableRegions(event.payload.cells, currentCwd);
    grid.setClickableRegions(regions);
  }, 200);
});

// Dynamic initial size based on container dimensions
const initCols = Math.max(1, Math.floor(container.clientWidth / 9));
const initRows = Math.max(1, Math.floor(container.clientHeight / 18));
invoke("init_terminal", { rows: initRows, cols: initCols }).catch((err) => {
  console.error("init_terminal failed:", err);
});

// ─── Resize observer — grid adapts to window ─────────────────────────────────

let resizeTimer: number | null = null;
const resizeObserver = new ResizeObserver((entries) => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const cols = Math.floor(width / 9);   // CELL_WIDTH  = 9px
      const rows = Math.floor(height / 18); // CELL_HEIGHT = 18px
      if (cols > 0 && rows > 0) {
        grid.resize(rows, cols);
        invoke("resize_terminal", { rows, cols }).catch(console.warn);
      }
    }
  }, 50);
});
resizeObserver.observe(container);

// ─── Canvas mouse interaction — hover highlights + click-to-open ─────────────

const terminalCanvas = grid.getCanvas();

terminalCanvas.addEventListener("mousemove", (event: MouseEvent) => {
  const { row, col } = grid.getCellFromClick(event);
  const region = findRegionAt(grid.getClickableRegions(), row, col);
  grid.setHoveredRegion(region ?? null);
});

terminalCanvas.addEventListener("mouseleave", () => {
  grid.setHoveredRegion(null);
});

terminalCanvas.addEventListener("click", async (event: MouseEvent) => {
  const { row, col } = grid.getCellFromClick(event);
  const region = findRegionAt(grid.getClickableRegions(), row, col);
  if (!region) return;

  if (region.type === "url") {
    invoke("open_url", { url: region.value }).catch((err) => {
      console.error("open_url failed:", err);
    });
  } else if (region.type === "directory") {
    // Navigate shell into directory — send as if typed at the prompt
    const cmd = `cd ${region.value}\r`;
    const bytes = Array.from(new TextEncoder().encode(cmd));
    invoke("write_to_pty", { data: bytes }).catch((err) => {
      console.error("cd write_to_pty failed:", err);
    });
  } else if (region.type === "file") {
    invoke("open_file", { path: region.value }).catch((err) => {
      console.error("open_file failed:", err);
    });
  }
});

// ─── Keyboard input ───────────────────────────────────────────────────────────

// Track what the user is currently typing so we can capture full commands
let currentInput = "";

window.addEventListener("keydown", async (event) => {
  const { key, ctrlKey, metaKey } = event;

  // ── Cmd+V — paste from clipboard ─────────────────────────────────────────
  if (metaKey && key === "v") {
    event.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const bytes = Array.from(new TextEncoder().encode(text));
        await invoke("write_to_pty", { data: bytes });
      }
    } catch {
      // Clipboard read denied or empty — silent fail
    }
    return;
  }

  // ── Cmd+C — selection not yet implemented, just swallow it ───────────────
  if (metaKey && key === "c") {
    event.preventDefault();
    return;
  }

  // Build up the current input line for context tracking
  if (!ctrlKey) {
    if (key === "Enter") {
      const line = currentInput.trim();

      if (line.startsWith("/")) {
        // ── Slash command — intercept before PTY ──
        event.preventDefault();
        effects?.commandSubmit();
        const result = dispatchCommand(line);
        if (result) {
          const res = await result;
          if ("type" in res && res.type === "menu") {
            // MenuResult — handled by menu component (Task 2)
            overlay.dismiss();
          } else {
            overlay.showMessage(res.output, res.isError);
          }
        }
        currentInput = "";
        return;
      }

      if (line.startsWith(">>")) {
        // ── LLM query — don't send to PTY ──
        event.preventDefault();
        effects?.commandSubmit();
        overlay.dismiss(); // clear any previous overlay
        llm.query(line).catch((err) => console.error("llm.query failed:", err));
        currentInput = "";
        return;
      }

      // Regular shell command — record it for context, fire submit effect
      if (line.length > 0) {
        commandHistory.addCommand(line);
        effects?.commandSubmit();
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
