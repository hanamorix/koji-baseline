// idle.ts — Idle animator: holographic scan line + kanji cycling
// Triggers after 30 s of no input.  Resets on keydown / mousemove.

const IDLE_THRESHOLD_MS = 30_000;

const KANJI_CYCLE = Array.from("光路影幻夢霧雨風雷炎氷星月闇");

type StateChangeCallback = (idle: boolean) => void;

export class IdleAnimator {
  private canvas: HTMLCanvasElement | null = null;
  private lastInput: number = Date.now();
  private isIdle: boolean   = false;
  private rafId: number     = 0;
  private kanjiIndex: number = 0;
  private kanjiInterval: ReturnType<typeof setInterval> | null = null;
  private stateCallbacks: StateChangeCallback[] = [];

  // ── event wiring ─────────────────────────────────────────────────────────────

  constructor() {
    const reset = () => this.resetIdle();
    window.addEventListener("keydown",   reset);
    window.addEventListener("mousemove", reset);
  }

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
  }

  onStateChange(cb: StateChangeCallback): void {
    this.stateCallbacks.push(cb);
  }

  getCurrentKanji(): string {
    return KANJI_CYCLE[this.kanjiIndex];
  }

  // ── idle state machine ───────────────────────────────────────────────────────

  private resetIdle(): void {
    this.lastInput = Date.now();
    if (this.isIdle) {
      this.isIdle = false;
      this.stopIdle();
      this.notify(false);
    }
  }

  private notify(idle: boolean): void {
    for (const cb of this.stateCallbacks) cb(idle);
  }

  // Called externally each animation frame (or by its own rAF loop)
  tick(): void {
    if (!this.isIdle && Date.now() - this.lastInput >= IDLE_THRESHOLD_MS) {
      this.isIdle = true;
      this.startIdle();
      this.notify(true);
    }

    if (this.isIdle) this.drawScanLine();
  }

  // ── scan line ────────────────────────────────────────────────────────────────

  private scanY: number = 0;
  private scanStartTime: number = 0;

  private drawScanLine(): void {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = this.canvas;
    const now    = Date.now();
    const elapsed = now - this.scanStartTime;

    // Full sweep in 3 s
    this.scanY = ((elapsed / 3000) % 1) * height;

    ctx.fillStyle = "rgba(255,106,0,0.02)";
    ctx.fillRect(0, this.scanY, width, 6);
  }

  // ── kanji cycling ────────────────────────────────────────────────────────────

  private startIdle(): void {
    this.scanStartTime = Date.now();
    this.kanjiInterval = setInterval(() => {
      this.kanjiIndex = (this.kanjiIndex + 1) % KANJI_CYCLE.length;
      // Notify so status bar can re-render the icon
      this.notify(true);
    }, 800);
  }

  private stopIdle(): void {
    if (this.kanjiInterval !== null) {
      clearInterval(this.kanjiInterval);
      this.kanjiInterval = null;
    }
  }

  // ── rAF self-drive (optional — caller can call tick() manually instead) ──────

  start(): void {
    const loop = () => {
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.stopIdle();
  }
}
