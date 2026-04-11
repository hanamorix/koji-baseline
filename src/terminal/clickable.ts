// clickable.ts — URL and file-path detection for DOM grid rows.
// Scans terminal output for clickable URLs and file paths.
// Uses event delegation on the scroll container instead of per-cell listeners.

import { invoke } from "@tauri-apps/api/core";

/** Stash detected regions on the row element so the delegated handler can find them. */
interface ClickableRegion {
  start: number;
  end: number;
  type: string;
  value: string;
}

declare global {
  interface HTMLElement {
    _clickableRegions?: ClickableRegion[];
  }
}

/** One-time setup: attach delegated click and hover handlers to the scroll container. */
let delegationInstalled = false;
let activeWriteFn: ((data: number[]) => Promise<void>) | undefined;

function installDelegation(scrollEl: HTMLElement): void {
  if (delegationInstalled) return;
  delegationInstalled = true;

  let hoveredRegion: { row: HTMLElement; region: ClickableRegion } | null = null;

  scrollEl.addEventListener("mouseover", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".cell") as HTMLElement | null;
    if (!cell) return;
    const row = cell.parentElement;
    if (!row || !row._clickableRegions) return;

    const cells = row.querySelectorAll(".cell");
    const cellIdx = Array.from(cells).indexOf(cell);
    if (cellIdx < 0) return;

    const region = row._clickableRegions.find((r) => cellIdx >= r.start && cellIdx < r.end);
    if (!region) return;

    // Apply hover class to the whole region
    for (let c = region.start; c < region.end && c < cells.length; c++) {
      (cells[c] as HTMLElement).classList.add("clickable-hover");
    }
    hoveredRegion = { row, region };
  });

  scrollEl.addEventListener("mouseout", (e) => {
    if (!hoveredRegion) return;
    const cell = (e.target as HTMLElement).closest?.(".cell") as HTMLElement | null;
    if (!cell) return;

    const cells = hoveredRegion.row.querySelectorAll(".cell");
    const { region } = hoveredRegion;
    for (let c = region.start; c < region.end && c < cells.length; c++) {
      (cells[c] as HTMLElement).classList.remove("clickable-hover");
    }
    hoveredRegion = null;
  });

  scrollEl.addEventListener("click", (e) => {
    const cell = (e.target as HTMLElement).closest?.(".cell") as HTMLElement | null;
    if (!cell) return;
    const row = cell.parentElement;
    if (!row || !row._clickableRegions) return;

    const cells = row.querySelectorAll(".cell");
    const cellIdx = Array.from(cells).indexOf(cell);
    if (cellIdx < 0) return;

    const region = row._clickableRegions.find((r) => cellIdx >= r.start && cellIdx < r.end);
    if (!region) return;

    if (region.type === "url") {
      invoke("open_url", { url: region.value }).catch(console.error);
    } else {
      invoke("check_path_type", { path: region.value }).then((pathType: unknown) => {
        if (pathType === "file") {
          invoke("open_file", { path: region.value }).catch(console.error);
        } else if (pathType === "directory" && activeWriteFn) {
          const cmd = `cd ${region.value}\r`;
          const bytes = Array.from(new TextEncoder().encode(cmd));
          activeWriteFn(bytes).catch(console.error);
        }
      }).catch(() => {});
    }
  });
}

/** Apply clickable detection to DOM grid rows. Call debounced after render. */
export async function applyClickableRegions(
  scrollEl: HTMLElement,
  mouseMode: number,
  writeFn?: (data: number[]) => Promise<void>,
): Promise<void> {
  if (mouseMode > 0) return; // Don't detect when mouse reporting is active

  activeWriteFn = writeFn;
  installDelegation(scrollEl);

  const rows = scrollEl.querySelectorAll(".grid-row");
  const lastRows = Array.from(rows).slice(-50); // Only scan last 50 rows for performance

  for (const rowEl of lastRows) {
    const el = rowEl as HTMLDivElement;
    if (el.dataset.clickableScanned) continue;
    el.dataset.clickableScanned = "1";

    const text = el.textContent ?? "";
    const urlRe = /https?:\/\/[^\s)>\]]+/g;
    const pathRe = /(?:~|\.)?\/[^\s)>\]]+/g;

    const regions: ClickableRegion[] = [];

    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "url", value: m[0] });
    }
    while ((m = pathRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "path", value: m[0] });
    }

    if (regions.length > 0) {
      el._clickableRegions = regions;
    }
  }
}
