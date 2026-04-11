// palette.ts — Cmd+Shift+P command palette with fuzzy filtering
// Shows executable slash commands + informational keybinding reference.

import type { KeybindingManager } from "./keybindings";
import { KeybindingManager as KBM } from "./keybindings";
import { dispatchCommand } from "../commands/router";
import type { DispatchResult, MenuResult } from "../commands/router";
import { overlay } from "../overlay/overlay";

// ─── State ───────────────────────────────────────────────────────────────────

let paletteEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;
let highlightIndex = 0;
let filteredItems: PaletteItem[] = [];
let captureHandler: ((e: KeyboardEvent) => void) | null = null;

interface PaletteItem {
  label: string;
  hint: string;
  command: string | null;   // null = display-only (keybinding reference)
  section?: string;
}

// ─── Slash commands shown in the palette ──────────────────────────────────────

const SLASH_COMMANDS: PaletteItem[] = [
  { label: "/help",              hint: "Show available commands",        command: "/help" },
  { label: "/theme",             hint: "Change colour theme",           command: "/theme" },
  { label: "/font",              hint: "Switch terminal font",          command: "/font" },
  { label: "/cursor",            hint: "Change cursor style",           command: "/cursor" },
  { label: "/agent",             hint: "Open agent chat pane",          command: "/agent" },
  { label: "/exit",              hint: "Close session",                 command: "/exit" },
  { label: "/version",           hint: "Show version info",             command: "/version" },
  { label: "/shell-integration", hint: "Shell integration status",      command: "/shell-integration" },
  { label: "/terminfo",          hint: "Terminal capabilities",         command: "/terminfo" },
  { label: "/llm models",        hint: "List available LLM models",     command: "/llm models" },
];

// ─── Build palette items ─────────────────────────────────────────────────────

function buildItems(keybindings: KeybindingManager): PaletteItem[] {
  const items: PaletteItem[] = [];

  // Section: Commands
  for (const cmd of SLASH_COMMANDS) {
    items.push({ ...cmd, section: "Commands" });
  }

  // Section: Keyboard Shortcuts (display-only reference)
  for (const b of keybindings.getAllBindings()) {
    const label = toTitleCase(b.action);
    const hint = KBM.formatCombo(b.comboStr);
    items.push({ label, hint, command: null, section: "Keyboard Shortcuts" });
  }

  return items;
}

function toTitleCase(action: string): string {
  return action
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Filtering ───────────────────────────────────────────────────────────────

function filterItems(allItems: PaletteItem[], query: string): PaletteItem[] {
  if (!query) return allItems;
  const q = query.toLowerCase();
  return allItems.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.hint.toLowerCase().includes(q),
  );
}

// ─── Render ──────────────────────────────────────────────────────────────────

function renderList(): void {
  if (!listEl) return;
  listEl.innerHTML = "";

  let lastSection = "";
  for (let i = 0; i < filteredItems.length; i++) {
    const item = filteredItems[i];

    // Section header
    if (item.section && item.section !== lastSection) {
      lastSection = item.section;
      const sec = document.createElement("div");
      sec.className = "palette-section";
      sec.textContent = item.section;
      listEl.appendChild(sec);
    }

    const row = document.createElement("div");
    row.className = "palette-item" + (i === highlightIndex ? " highlighted" : "");
    if (!item.command) row.style.opacity = "0.6";

    const labelSpan = document.createElement("span");
    labelSpan.className = "palette-item-label";
    labelSpan.textContent = item.label;

    const hintSpan = document.createElement("span");
    hintSpan.className = "palette-item-hint";
    hintSpan.textContent = item.hint;

    row.appendChild(labelSpan);
    row.appendChild(hintSpan);

    // Click to execute (only for commands)
    const idx = i;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      highlightIndex = idx;
      executeHighlighted();
    });

    row.addEventListener("mouseenter", () => {
      highlightIndex = idx;
      renderList();
    });

    listEl.appendChild(row);
  }

  // Scroll highlighted item into view
  const highlighted = listEl.querySelector(".palette-item.highlighted");
  if (highlighted) {
    highlighted.scrollIntoView({ block: "nearest" });
  }
}

// ─── Execute ─────────────────────────────────────────────────────────────────

async function executeHighlighted(): Promise<void> {
  const item = filteredItems[highlightIndex];
  if (!item || !item.command) return;

  closePalette();

  const result = dispatchCommand(item.command);
  if (!result) return;

  let resolved: DispatchResult;
  try {
    resolved = await result;
  } catch (err) {
    overlay.showMessage(`Error: ${err}`, true);
    return;
  }

  if ("type" in resolved && resolved.type === "menu") {
    // Dynamic import to avoid circular deps
    const { openMenu } = await import("../overlay/menu");
    openMenu(resolved as MenuResult);
  } else if ("output" in resolved) {
    overlay.showMessage(resolved.output, resolved.isError);
  }
}

// ─── Open / Close / Query ────────────────────────────────────────────────────

let allItems: PaletteItem[] = [];

export function openPalette(keybindings: KeybindingManager): void {
  // Toggle if already open
  if (paletteEl) {
    closePalette();
    return;
  }

  allItems = buildItems(keybindings);
  filteredItems = allItems;
  highlightIndex = 0;

  // Build DOM
  paletteEl = document.createElement("div");
  paletteEl.className = "palette-overlay";

  const modal = document.createElement("div");
  modal.className = "palette-modal";

  inputEl = document.createElement("input");
  inputEl.className = "palette-input";
  inputEl.type = "text";
  inputEl.placeholder = "Type a command…";
  inputEl.spellcheck = false;

  listEl = document.createElement("div");
  listEl.className = "palette-list";

  modal.appendChild(inputEl);
  modal.appendChild(listEl);
  paletteEl.appendChild(modal);
  document.body.appendChild(paletteEl);

  renderList();
  inputEl.focus();

  // Input filter
  inputEl.addEventListener("input", () => {
    const query = inputEl!.value;
    filteredItems = filterItems(allItems, query);
    highlightIndex = 0;
    renderList();
  });

  // Click outside modal to close
  paletteEl.addEventListener("mousedown", (e) => {
    if (e.target === paletteEl) {
      e.preventDefault();
      closePalette();
    }
  });

  // Capture keyboard at window level so main.ts doesn't see it
  captureHandler = (e: KeyboardEvent) => {
    if (!paletteEl) return;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopImmediatePropagation();
        closePalette();
        break;

      case "ArrowDown":
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filteredItems.length > 0) {
          highlightIndex = (highlightIndex + 1) % filteredItems.length;
          renderList();
        }
        break;

      case "ArrowUp":
        e.preventDefault();
        e.stopImmediatePropagation();
        if (filteredItems.length > 0) {
          highlightIndex =
            (highlightIndex - 1 + filteredItems.length) % filteredItems.length;
          renderList();
        }
        break;

      case "Enter":
        e.preventDefault();
        e.stopImmediatePropagation();
        executeHighlighted();
        break;

      default:
        // Let typing reach the input
        e.stopImmediatePropagation();
        break;
    }
  };

  window.addEventListener("keydown", captureHandler, true);
}

export function closePalette(): void {
  if (captureHandler) {
    window.removeEventListener("keydown", captureHandler, true);
    captureHandler = null;
  }
  if (paletteEl) {
    paletteEl.remove();
    paletteEl = null;
    inputEl = null;
    listEl = null;
  }
  filteredItems = [];
  allItems = [];
  highlightIndex = 0;
}

export function isPaletteOpen(): boolean {
  return paletteEl !== null;
}
