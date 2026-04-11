// effects.ts — CSS-based command transition effects

export class TransitionEffects {
  private gridEl: HTMLElement;

  constructor(gridEl: HTMLElement) {
    this.gridEl = gridEl;
  }

  /** Brief amber flash across the entire grid on command submit. */
  commandSubmit(): void {
    this.gridEl.classList.remove("effect-flash");
    void this.gridEl.offsetWidth;
    this.gridEl.classList.add("effect-flash");
    this.gridEl.addEventListener("animationend", () => {
      this.gridEl.classList.remove("effect-flash");
    }, { once: true });
  }

  /** Soft amber flash for terminal bell. */
  bell(): void {
    this.gridEl.classList.remove("effect-bell");
    void this.gridEl.offsetWidth;
    this.gridEl.classList.add("effect-bell");
    this.gridEl.addEventListener("animationend", () => {
      this.gridEl.classList.remove("effect-bell");
    }, { once: true });
  }
}
