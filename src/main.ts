// main.ts — Koji terminal frontend
// PTY → engine → event → Canvas. Keyboard → ANSI → write_to_pty.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TerminalGrid, GridSnapshot } from "./terminal/grid";

// ─── Boot ─────────────────────────────────────────────────────────────────────

const container = document.getElementById("terminal-container");
if (!container) throw new Error("#terminal-container not found");

const grid = new TerminalGrid(container);

// Receive terminal snapshots from the Rust I/O thread and paint them
listen<GridSnapshot>("terminal-output", (event) => {
  grid.render(event.payload);
});

// Fire up the PTY — 24 rows × 80 cols by default
invoke("init_terminal", { rows: 24, cols: 80 }).catch((err) => {
  console.error("init_terminal failed:", err);
});

// ─── Keyboard input ───────────────────────────────────────────────────────────

window.addEventListener("keydown", (event) => {
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
      // Single printable character — pass through as-is
      if (key.length === 1 && !ctrlKey) return key;
      return null;
  }
}
