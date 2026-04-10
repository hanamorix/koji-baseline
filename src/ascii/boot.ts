// boot.ts — ASCII boot sequence animation
// Phase 1: char-by-char logo with holographic flicker
// Phase 2: boot messages with styled prefixes
// Phase 3: fade to black
// Any keypress skips the whole thing.

import { KOJI_LOGO, BOOT_MESSAGES } from "./art/logo";

const AMBER         = "#cc7a00";
const PREFIX_DIM    = "#996b00";
const PASS_GREEN    = "#3a6a3a";
const BG            = "rgb(10,10,10)";
const FONT_SIZE     = 13;
const FONT_FACE     = "monospace";
const LINE_HEIGHT   = FONT_SIZE * 1.4;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BootSequence {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private skipped = false;
  private skipHandler: () => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d")!;

    // Scale for Retina/HiDPI displays
    const dpr = window.devicePixelRatio || 1;
    this.ctx.scale(dpr, dpr);

    this.skipHandler = () => { this.skipped = true; };
    window.addEventListener("keydown",   this.skipHandler, { once: false });
    window.addEventListener("mousedown", this.skipHandler, { once: false });
  }

  private cleanup(): void {
    window.removeEventListener("keydown",   this.skipHandler);
    window.removeEventListener("mousedown", this.skipHandler);
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  /** Logical canvas dimensions (context is already DPR-scaled) */
  private get logicalWidth(): number {
    return this.canvas.width / (window.devicePixelRatio || 1);
  }
  private get logicalHeight(): number {
    return this.canvas.height / (window.devicePixelRatio || 1);
  }

  private clear(): void {
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
  }

  private setFont(): void {
    this.ctx.font = `${FONT_SIZE}px ${FONT_FACE}`;
  }

  // ── Phase 1: logo ────────────────────────────────────────────────────────────

  private async renderLogo(): Promise<void> {
    const { ctx } = this;
    this.clear();
    this.setFont();

    const lines  = KOJI_LOGO.split("\n");
    const startY = Math.max(
      LINE_HEIGHT * 2,
      (this.logicalHeight - lines.length * LINE_HEIGHT) / 2,
    );

    // Render every character, 3-at-a-time with 5 ms delay between batches
    let batchCount = 0;

    for (let li = 0; li < lines.length; li++) {
      if (this.skipped) return;

      const line = lines[li];
      const y    = startY + li * LINE_HEIGHT;
      const charW = ctx.measureText("█").width;

      for (let ci = 0; ci < line.length; ci++) {
        if (this.skipped) return;

        const ch = line[ci];

        // ~10% holographic flicker: slight x-offset
        const flicker = Math.random() < 0.10;
        const xOffset = flicker ? (Math.random() * 4 - 2) : 0;
        const x       = ci * charW + xOffset;

        // Flicker chars get a slightly lighter amber
        ctx.fillStyle = flicker ? "#e08800" : AMBER;
        ctx.fillText(ch, x, y);

        batchCount++;
        if (batchCount % 3 === 0) {
          await delay(5);
          if (this.skipped) return;
        }
      }
    }
  }

  // ── Phase 2: boot messages ───────────────────────────────────────────────────

  private async renderMessages(): Promise<void> {
    const { ctx } = this;
    this.setFont();

    const charW  = ctx.measureText("M").width;
    const startX = charW * 4;   // indent to match logo margin
    const logoLines = KOJI_LOGO.split("\n").length;
    let   msgY   = LINE_HEIGHT * 2 + logoLines * LINE_HEIGHT + LINE_HEIGHT;

    // If messages would overflow, scroll from top
    if (msgY + BOOT_MESSAGES.length * LINE_HEIGHT > this.logicalHeight) {
      msgY = this.logicalHeight - BOOT_MESSAGES.length * LINE_HEIGHT - LINE_HEIGHT * 2;
    }

    for (let i = 0; i < BOOT_MESSAGES.length; i++) {
      if (this.skipped) return;

      const raw = BOOT_MESSAGES[i];
      await delay(150);
      if (this.skipped) return;

      if (raw === "") {
        // blank line — just advance
        msgY += LINE_HEIGHT;
        continue;
      }

      // Tokenise: prefix [XXX], PASS keyword, rest
      const prefixMatch = raw.match(/^(\[[A-Z]+\])\s*(.*)/);

      if (prefixMatch) {
        const prefix = prefixMatch[1];
        const rest   = " " + prefixMatch[2];

        // Draw prefix in dim amber
        ctx.fillStyle = PREFIX_DIM;
        ctx.fillText(prefix, startX, msgY);

        const prefixW = ctx.measureText(prefix).width;

        // Highlight PASS in green, everything else in full amber
        if (rest.includes("PASS")) {
          const parts = rest.split("PASS");
          let curX    = startX + prefixW;
          for (let p = 0; p < parts.length; p++) {
            ctx.fillStyle = AMBER;
            ctx.fillText(parts[p], curX, msgY);
            curX += ctx.measureText(parts[p]).width;
            if (p < parts.length - 1) {
              ctx.fillStyle = PASS_GREEN;
              ctx.fillText("PASS", curX, msgY);
              curX += ctx.measureText("PASS").width;
            }
          }
        } else {
          ctx.fillStyle = AMBER;
          ctx.fillText(rest, startX + prefixW, msgY);
        }
      } else {
        // Flavour line — full amber, centred-ish
        ctx.fillStyle = AMBER;
        const textW = ctx.measureText(raw).width;
        const cx    = (this.logicalWidth - textW) / 2;
        ctx.fillText(raw, cx, msgY);
      }

      msgY += LINE_HEIGHT;
    }
  }

  // ── Phase 3: fade out ────────────────────────────────────────────────────────

  private async fadeOut(): Promise<void> {
    const { ctx } = this;
    // Progressively cover with near-transparent black until opaque
    for (let alpha = 0; alpha < 1; alpha += 0.05) {
      if (this.skipped) break;
      ctx.fillStyle = "rgba(10,10,10,0.05)";
      ctx.fillRect(0, 0, this.logicalWidth, this.logicalHeight);
      await delay(16); // ~60fps
    }
    // Guarantee full black at the end
    this.clear();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async play(): Promise<void> {
    try {
      await this.renderLogo();
      if (!this.skipped) await this.renderMessages();
      if (!this.skipped) await delay(300);
      await this.fadeOut();
    } finally {
      this.cleanup();
    }
  }
}
