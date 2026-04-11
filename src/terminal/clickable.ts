// clickable.ts — URL and file-path detection for DOM grid rows.
// Scans terminal output for clickable URLs and file paths.
// Hover underlines, click opens browser/editor/cd.

import { invoke } from "@tauri-apps/api/core";

/** Apply clickable detection to DOM grid rows. Call debounced after render. */
export async function applyClickableRegions(
  scrollEl: HTMLElement,
  mouseMode: number,
  writeFn?: (data: number[]) => Promise<void>,
): Promise<void> {
  if (mouseMode > 0) return; // Don't detect when mouse reporting is active

  const rows = scrollEl.querySelectorAll(".grid-row");
  const lastRows = Array.from(rows).slice(-50); // Only scan last 50 rows for performance

  for (const rowEl of lastRows) {
    const el = rowEl as HTMLDivElement;
    if (el.dataset.clickableScanned) continue;
    el.dataset.clickableScanned = "1";

    const text = el.textContent ?? "";
    const urlRe = /https?:\/\/[^\s)>\]]+/g;
    const pathRe = /(?:~|\.)?\/[^\s)>\]]+/g;

    const regions: { start: number; end: number; type: string; value: string }[] = [];

    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "url", value: m[0] });
    }
    while ((m = pathRe.exec(text)) !== null) {
      regions.push({ start: m.index, end: m.index + m[0].length, type: "path", value: m[0] });
    }

    const cells = el.querySelectorAll(".cell");
    for (const region of regions) {
      for (let c = region.start; c < region.end && c < cells.length; c++) {
        const cell = cells[c] as HTMLElement;

        cell.addEventListener("mouseenter", () => {
          for (let cc = region.start; cc < region.end && cc < cells.length; cc++) {
            (cells[cc] as HTMLElement).classList.add("clickable-hover");
          }
        });

        cell.addEventListener("mouseleave", () => {
          for (let cc = region.start; cc < region.end && cc < cells.length; cc++) {
            (cells[cc] as HTMLElement).classList.remove("clickable-hover");
          }
        });

        cell.addEventListener("click", () => {
          if (region.type === "url") {
            invoke("open_url", { url: region.value }).catch(console.error);
          } else {
            invoke("check_path_type", { path: region.value }).then((pathType: unknown) => {
              if (pathType === "file") {
                invoke("open_file", { path: region.value }).catch(console.error);
              } else if (pathType === "directory" && writeFn) {
                const cmd = `cd ${region.value}\r`;
                const bytes = Array.from(new TextEncoder().encode(cmd));
                writeFn(bytes).catch(console.error);
              }
            }).catch(() => {});
          }
        });
      }
    }
  }
}
