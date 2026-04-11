// zones.ts — Cmd+Up/Down navigation between command zones (OSC 133 prompts)

import type { DOMGrid } from "./dom-grid";
import type { CommandZone } from "../tabs/tab-session";

export function findNearestZone(
  zones: CommandZone[],
  direction: "up" | "down",
  currentScrollTop: number,
  lineHeight: number,
): number | null {
  if (zones.length === 0) return null;

  const currentLine = Math.floor(currentScrollTop / lineHeight);

  if (direction === "up") {
    for (let i = zones.length - 1; i >= 0; i--) {
      if (zones[i].prompt_line < currentLine) {
        return zones[i].prompt_line;
      }
    }
    return null;
  } else {
    for (let i = 0; i < zones.length; i++) {
      if (zones[i].prompt_line > currentLine) {
        return zones[i].prompt_line;
      }
    }
    return null;
  }
}

export function scrollToLine(
  grid: DOMGrid,
  line: number,
  lineHeight: number,
): void {
  const scrollEl = grid.getScrollElement();
  const targetTop = line * lineHeight;
  scrollEl.scrollTo({ top: targetTop, behavior: "smooth" });
}
