// clickable.ts — URL and file-path region detection for the terminal canvas.
// Scans the visible grid for clickable targets: https?:// URLs and file paths.
// File paths are validated via Tauri's check_path_type command before inclusion.

import { invoke } from "@tauri-apps/api/core";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClickableRegion {
  row: number;
  colStart: number;
  colEnd: number;
  type: "url" | "directory" | "file";
  value: string;
}

// ─── Regex patterns ───────────────────────────────────────────────────────────

const URL_RE    = /https?:\/\/[^\s)>\]]+/g;
const PATH_RE   = /(?:~|\.)?\/[^\s)>\]]+/g;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collapse a row of cells into a plain string. */
export function rowToText(cells: Array<{ character: string }>): string {
  return cells.map((c) => c.character ?? " ").join("");
}

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Scan every visible row for URLs and file-system paths.
 * URLs are always included. Paths are validated by the Rust backend
 * (`check_path_type`) and only included when they resolve to a real
 * file or directory.
 */
export async function detectClickableRegions(
  grid: Array<Array<{ character: string }>>,
  _cwd: string,
): Promise<ClickableRegion[]> {
  const regions: ClickableRegion[] = [];
  const pathChecks: Array<Promise<void>> = [];

  for (let row = 0; row < grid.length; row++) {
    const cells = grid[row];
    if (!cells || cells.length === 0) continue;

    const text = rowToText(cells);

    // ── URLs — always clickable, no validation ────────────────────────────
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      regions.push({
        row,
        colStart: m.index,
        colEnd:   m.index + m[0].length - 1,
        type:     "url",
        value:    m[0],
      });
    }

    // ── File/dir paths — validate before including ────────────────────────
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(text)) !== null) {
      const rawPath   = m[0];
      const colStart  = m.index;
      const colEnd    = m.index + rawPath.length - 1;
      const captured  = rawPath; // capture for closure

      const check = invoke<string | null>("check_path_type", { path: captured })
        .then((kind) => {
          if (kind === "file" || kind === "directory") {
            regions.push({
              row,
              colStart,
              colEnd,
              type:  kind,
              value: captured,
            });
          }
        })
        .catch(() => { /* inaccessible path — skip silently */ });

      pathChecks.push(check);
    }
  }

  await Promise.all(pathChecks);

  // Sort so callers get a predictable top-to-bottom order
  regions.sort((a, b) => a.row - b.row || a.colStart - b.colStart);

  return regions;
}

/**
 * Find the first region that contains the given (row, col) coordinate.
 * Returns null if the coordinate is not inside any known region.
 */
export function findRegionAt(
  regions: ClickableRegion[],
  row: number,
  col: number,
): ClickableRegion | null {
  for (const region of regions) {
    if (region.row === row && col >= region.colStart && col <= region.colEnd) {
      return region;
    }
  }
  return null;
}
