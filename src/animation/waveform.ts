// waveform.ts — Wallace ambient waveform animator
// Sine-driven block-character waveform. CPU load drives animation speed.
// Higher CPU → faster, more frantic wave. Idle → slow amber drift.

const WAVE_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WAVE_LEN   = WAVE_CHARS.length; // 8 levels

// Speed range: 0.4 rad/s at idle, 4.0 rad/s at 100% CPU
const SPEED_MIN  = 0.4;
const SPEED_MAX  = 4.0;

export class WaveformAnimator {
  private topEl:    HTMLElement | null;
  private bottomEl: HTMLElement | null;
  private phase     = 0;
  private lastTs    = 0;
  private rafId: number | null = null;
  private cpuPercent = 0;

  constructor(topId: string, bottomId: string) {
    this.topEl    = document.getElementById(topId);
    this.bottomEl = document.getElementById(bottomId);
  }

  /** Called by the system-stats listener in main.ts */
  setCpuPercent(percent: number): void {
    this.cpuPercent = Math.max(0, Math.min(100, percent));
  }

  start(): void {
    if (this.rafId !== null) return; // already running
    const tick = (ts: number) => {
      const dt = this.lastTs === 0 ? 0 : (ts - this.lastTs) / 1000; // seconds
      this.lastTs = ts;

      // Linearly interpolate speed from cpu %
      const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * (this.cpuPercent / 100);
      this.phase += speed * dt;

      this.paint(this.topEl,    this.phase);
      this.paint(this.bottomEl, this.phase + Math.PI); // bottom is phase-inverted

      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private paint(el: HTMLElement | null, phase: number): void {
    if (!el) return;

    // Fill the element width with characters; measure char count from clientWidth
    const charCount = Math.max(Math.floor((el.clientWidth || 800) / 7), 40);
    let out = "";
    for (let i = 0; i < charCount; i++) {
      // Sine in [-1, 1] → normalised [0, 1] → index into WAVE_CHARS
      const sine    = Math.sin(phase + i * 0.15);
      const norm    = (sine + 1) / 2;              // [0, 1]
      const idx     = Math.floor(norm * WAVE_LEN); // [0, 8]
      const clamped = Math.min(idx, WAVE_LEN - 1);
      out += WAVE_CHARS[clamped];
    }
    el.textContent = out;
  }
}
