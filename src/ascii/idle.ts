// idle.ts — Kanji cycling idle animation (no scan line, no RAF)

const IDLE_THRESHOLD_MS = 30_000;
const KANJI_CYCLE = "光路影幻夢霧雨風雷炎氷星月闇";
const KANJI_INTERVAL_MS = 800;

type StateCallback = (idle: boolean, kanji?: string) => void;

export class IdleAnimator {
  private lastInput = Date.now();
  private isIdle = false;
  private kanjiIndex = 0;
  private kanjiInterval: ReturnType<typeof setInterval> | null = null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private stateCallbacks: StateCallback[] = [];

  constructor() {
    const reset = () => this.resetIdle();
    document.addEventListener("keydown", reset);
    document.addEventListener("mousemove", reset);
  }

  onStateChange(cb: StateCallback): void {
    this.stateCallbacks.push(cb);
  }

  getCurrentKanji(): string {
    return KANJI_CYCLE[this.kanjiIndex % KANJI_CYCLE.length];
  }

  private resetIdle(): void {
    this.lastInput = Date.now();
    if (this.isIdle) {
      this.stopIdle();
      this.isIdle = false;
      this.notify(false);
    }
  }

  private notify(idle: boolean): void {
    const kanji = idle ? this.getCurrentKanji() : undefined;
    this.stateCallbacks.forEach((cb) => cb(idle, kanji));
  }

  private startIdle(): void {
    this.isIdle = true;
    this.kanjiIndex = 0;
    this.notify(true);
    this.kanjiInterval = setInterval(() => {
      this.kanjiIndex = (this.kanjiIndex + 1) % KANJI_CYCLE.length;
      this.notify(true);
    }, KANJI_INTERVAL_MS);
  }

  private stopIdle(): void {
    if (this.kanjiInterval) {
      clearInterval(this.kanjiInterval);
      this.kanjiInterval = null;
    }
  }

  /** Start the idle checker. Uses setInterval instead of RAF — no animation frames consumed. */
  start(): void {
    this.checkInterval = setInterval(() => {
      if (!this.isIdle && Date.now() - this.lastInput >= IDLE_THRESHOLD_MS) {
        this.startIdle();
      }
    }, 1000);
  }

  stop(): void {
    this.stopIdle();
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}
