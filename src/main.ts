// main.ts — Koji terminal frontend
// PTY → engine → event → Canvas. Keyboard → ANSI → write_to_pty.
// Task 9: >> prefix routes to Ollama; commandHistory tracks shell I/O for context.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalGrid, GridSnapshot } from "./terminal/grid";
import { initDashboard } from "./dashboard/status-bar";
import { WaveformAnimator } from "./animation/waveform";
import { LlmPanel } from "./llm/panel";
import { commandHistory } from "./llm/context";

// ─── Boot ─────────────────────────────────────────────────────────────────────

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

const grid = new TerminalGrid(container);

// ─── LLM setup ───────────────────────────────────────────────────────────────

const llm = new LlmPanel();

// Wire streaming response into the grid renderer (Task 10 hook)
llm.onResponseUpdate((text, done) => {
  const snap = grid.getLastSnapshot();
  if (snap) {
    grid.setLlmResponse(text, done, snap.cursor.row);
  }
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

// ─── Terminal I/O ─────────────────────────────────────────────────────────────

listen<GridSnapshot>("terminal-output", (event) => {
  grid.render(event.payload);
});

invoke("init_terminal", { rows: 24, cols: 80 }).catch((err) => {
  console.error("init_terminal failed:", err);
});

// ─── Keyboard input ───────────────────────────────────────────────────────────

// Track what the user is currently typing so we can capture full commands
let currentInput = "";

window.addEventListener("keydown", (event) => {
  const { key, ctrlKey } = event;

  // Build up the current input line for context tracking
  if (!ctrlKey) {
    if (key === "Enter") {
      const line = currentInput.trim();

      if (line.startsWith(">>")) {
        // ── LLM query — don't send to PTY ──
        event.preventDefault();
        llm.query(line).catch((err) => console.error("llm.query failed:", err));
        currentInput = "";
        return;
      }

      // Regular shell command — record it for context
      if (line.length > 0) {
        commandHistory.addCommand(line);
      }
      currentInput = "";
    } else if (key === "Backspace") {
      currentInput = currentInput.slice(0, -1);
    } else if (key.length === 1) {
      currentInput += key;
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
