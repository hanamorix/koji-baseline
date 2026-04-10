// effects.ts — TransitionEffects: command submit sweep, completion pulse, error flicker

export class TransitionEffects {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d")!;
  }

  // ── commandSubmit ────────────────────────────────────────────────────────────
  // Brief horizontal scan-line sweep across the full canvas height.
  // Amber, 6% opacity, 4px stride.

  /** Get logical canvas dimensions (context is already DPR-scaled) */
  private logicalSize(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    return {
      width:  this.canvas.width / dpr,
      height: this.canvas.height / dpr,
    };
  }

  commandSubmit(): void {
    const { ctx } = this;
    const { width, height } = this.logicalSize();

    ctx.fillStyle = "rgba(255,106,0,0.06)";
    for (let y = 0; y < height; y += 4) {
      ctx.fillRect(0, y, width, 2);
    }

    // Fade it out over ~200 ms
    let alpha = 0.06;
    const fade = () => {
      alpha -= 0.006;
      if (alpha <= 0) return;
      ctx.fillStyle = `rgba(10,10,10,0.04)`;
      ctx.fillRect(0, 0, width, height);
      requestAnimationFrame(fade);
    };
    requestAnimationFrame(fade);
  }

  // ── commandComplete ──────────────────────────────────────────────────────────
  // Subtle amber pulse over the rows that just received output.
  // Fades from 8% → 0 opacity.

  commandComplete(startRow: number, endRow: number, cellHeight: number): void {
    const { ctx } = this;
    const y      = startRow * cellHeight;
    const height = (endRow - startRow + 1) * cellHeight;
    const { width } = this.logicalSize();

    let alpha = 0.08;
    const pulse = () => {
      if (alpha <= 0) return;
      ctx.fillStyle = `rgba(204,122,0,${alpha.toFixed(3)})`;
      ctx.fillRect(0, y, width, height);
      alpha -= 0.004;
      requestAnimationFrame(pulse);
    };
    requestAnimationFrame(pulse);
  }

  // ── errorFlicker ─────────────────────────────────────────────────────────────
  // 4 quick red flickers over the error row range.

  errorFlicker(startRow: number, endRow: number, cellHeight: number): void {
    const { ctx } = this;
    const y      = startRow * cellHeight;
    const height = (endRow - startRow + 1) * cellHeight;
    const { width } = this.logicalSize();
    const color  = "rgba(255,69,0,0.08)";

    let count = 0;
    const flicker = () => {
      if (count >= 8) return; // 4 on + 4 off = 8 frames
      if (count % 2 === 0) {
        ctx.fillStyle = color;
        ctx.fillRect(0, y, width, height);
      } else {
        // clear the flicker band — redraw BG color
        ctx.fillStyle = "rgba(10,10,10,1)";
        ctx.fillRect(0, y, width, height);
      }
      count++;
      setTimeout(flicker, 40);
    };
    flicker();
  }
}
