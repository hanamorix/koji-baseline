// scrollback.ts — Scrollback fade for the Wallace aesthetic layer
// Dims older lines above the cursor: full brightness at cursor, 25% at the top.
// Designed to be called from grid.ts during rendering to tint the fg colour.

/**
 * Return a dimmed version of a foreground colour based on how far the row
 * sits above the cursor row.
 *
 * @param fg         - Original [r, g, b] foreground colour
 * @param row        - Current row being rendered (0-indexed from top)
 * @param totalRows  - Total rows in the grid
 * @param cursorRow  - Row where the cursor sits
 * @returns          - Dimmed [r, g, b] tuple
 */
export function applyScrollbackFade(
  fg: [number, number, number],
  row: number,
  totalRows: number,
  cursorRow: number,
): [number, number, number] {
  // Rows at or below cursor — full brightness
  if (row >= cursorRow) return fg;

  // Distance above cursor expressed as 0.0 (at cursor) → 1.0 (top of screen)
  const distanceRatio = cursorRow > 0
    ? (cursorRow - row) / cursorRow
    : 0;

  // Fade: 1.0 at cursor → 0.25 at top (never fully invisible)
  const MIN_FACTOR = 0.25;
  const factor = 1.0 - distanceRatio * (1.0 - MIN_FACTOR);

  return [
    Math.round(fg[0] * factor),
    Math.round(fg[1] * factor),
    Math.round(fg[2] * factor),
  ];
}
