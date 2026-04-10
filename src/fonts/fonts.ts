// fonts.ts — Font management: curated picker, size controls, ligature toggle

import { invoke } from "@tauri-apps/api/core";

export interface FontOption {
  name: string;
  family: string;
  description: string;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    name: "JetBrains Mono",
    family: "JetBrains Mono",
    description: "Designed for code — tall x-height, 138 ligatures",
  },
  {
    name: "Fira Code",
    family: "Fira Code",
    description: "The OG ligature font — warm, rounded character",
  },
  {
    name: "Cascadia Code",
    family: "Cascadia Code",
    description: "Microsoft's terminal font — clean, modern, condensed",
  },
  {
    name: "Iosevka",
    family: "Iosevka",
    description: "Narrow and elegant — sci-fi aesthetic, fits more columns",
  },
];

export const DEFAULT_FONT = "JetBrains Mono";
export const DEFAULT_SIZE = 14;
export const MIN_SIZE = 10;
export const MAX_SIZE = 24;

export class FontManager {
  private currentFont: string = DEFAULT_FONT;
  private currentSize: number = DEFAULT_SIZE;
  private ligatures: boolean = true;
  private onChange: ((font: string, size: number, ligatures: boolean) => void) | null = null;

  setChangeCallback(cb: (font: string, size: number, ligatures: boolean) => void): void {
    this.onChange = cb;
  }

  getCurrent(): string {
    return this.currentFont;
  }

  getSize(): number {
    return this.currentSize;
  }

  getLigatures(): boolean {
    return this.ligatures;
  }

  async apply(fontName: string): Promise<boolean> {
    const option = FONT_OPTIONS.find((f) => f.name === fontName);
    if (!option) return false;

    this.currentFont = option.family;
    this.notify();
    await invoke("save_config", { key: "font", value: fontName });
    return true;
  }

  async setSize(size: number): Promise<void> {
    this.currentSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
    this.notify();
    await invoke("save_config", { key: "font_size", value: String(this.currentSize) });
  }

  async incrementSize(delta: number): Promise<void> {
    await this.setSize(this.currentSize + delta);
  }

  async setLigatures(enabled: boolean): Promise<void> {
    this.ligatures = enabled;
    this.notify();
    await invoke("save_config", { key: "ligatures", value: String(enabled) });
  }

  async loadSaved(): Promise<void> {
    try {
      const font = await invoke("load_config", { key: "font" }) as string;
      if (font) {
        const option = FONT_OPTIONS.find((f) => f.name === font);
        if (option) this.currentFont = option.family;
      }

      const size = await invoke("load_config", { key: "font_size" }) as string;
      if (size) {
        const parsed = parseInt(size, 10);
        if (!isNaN(parsed)) this.currentSize = Math.max(MIN_SIZE, Math.min(MAX_SIZE, parsed));
      }

      const lig = await invoke("load_config", { key: "ligatures" }) as string;
      if (lig === "false") this.ligatures = false;

      this.notify();
    } catch {
      // Config not found — use defaults
    }
  }

  private notify(): void {
    if (this.onChange) {
      this.onChange(this.currentFont, this.currentSize, this.ligatures);
    }
  }
}

export const fontManager = new FontManager();
