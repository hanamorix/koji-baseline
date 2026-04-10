// effects.ts — CSS-based command transition effects (no Canvas, no RAF)

export class TransitionEffects {
  private gridEl: HTMLElement;

  constructor(gridEl: HTMLElement) {
    this.gridEl = gridEl;
  }

  /** Brief amber flash across the entire grid on command submit. */
  commandSubmit(): void {
    this.gridEl.classList.remove("effect-flash");
    // Force reflow to restart animation
    void this.gridEl.offsetWidth;
    this.gridEl.classList.add("effect-flash");
    this.gridEl.addEventListener("animationend", () => {
      this.gridEl.classList.remove("effect-flash");
    }, { once: true });
  }

  /** Amber pulse on rows that received command output. */
  commandComplete(startRow: number, endRow: number): void {
    this.applyRowEffect("effect-complete", startRow, endRow);
  }

  /** Red flicker on error rows. */
  errorFlicker(startRow: number, endRow: number): void {
    this.applyRowEffect("effect-error", startRow, endRow);
  }

  private applyRowEffect(cls: string, startRow: number, endRow: number): void {
    const rows = this.gridEl.querySelectorAll(".grid-row");
    for (let i = startRow; i <= endRow && i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      row.classList.remove(cls);
      void row.offsetWidth;
      row.classList.add(cls);
      row.addEventListener("animationend", () => {
        row.classList.remove(cls);
      }, { once: true });
    }
  }
}
