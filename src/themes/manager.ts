// manager.ts — Kōji Baseline theme manager
// Single source of truth for runtime theme switching. One call, everything updates.

import { invoke } from "@tauri-apps/api/core";
import { THEMES, DEFAULT_THEME, Theme, TerminalColors } from "./themes";

// ─── CSS property map ─────────────────────────────────────────────────────────
// Maps ThemeColors keys → CSS custom property names on :root

const COLOR_CSS_MAP: Record<string, string> = {
  void:    "--koji-void",
  bright:  "--koji-bright",
  warm:    "--koji-warm",
  muted:   "--koji-muted",
  faded:   "--koji-faded",
  deep:    "--koji-deep",
  dim:     "--koji-dim",
  accent:  "--koji-orange",   // wallace.css uses --koji-orange for the accent slot
  error:   "--koji-error",
  success: "--koji-success",
  glow:    "--koji-glow",
};

// ─── ThemeManager ─────────────────────────────────────────────────────────────

class ThemeManager {
  private currentName: string = DEFAULT_THEME;

  // ── Getters ────────────────────────────────────────────────────────────────

  getCurrent(): Theme {
    return THEMES[this.currentName] ?? THEMES[DEFAULT_THEME];
  }

  getCurrentName(): string {
    return this.currentName;
  }

  // ── apply ──────────────────────────────────────────────────────────────────
  // Full theme switch: CSS vars → body bg → Rust backend → config persistence.

  async apply(themeName: string): Promise<void> {
    const theme = THEMES[themeName];
    if (!theme) {
      console.warn(`[ThemeManager] Unknown theme "${themeName}" — falling back to ${DEFAULT_THEME}`);
      return this.apply(DEFAULT_THEME);
    }

    this.currentName = themeName;

    // 1. Update CSS custom properties on :root
    const root = document.documentElement;
    for (const [colorKey, cssVar] of Object.entries(COLOR_CSS_MAP)) {
      const value = (theme.colors as unknown as Record<string, string>)[colorKey];
      if (value !== undefined) {
        root.style.setProperty(cssVar, value);
      }
    }

    // 2. Update body and #app background directly (CSS vars may not cascade
    //    fast enough for the first paint on boot)
    document.body.style.background = theme.colors.void;
    const appEl = document.getElementById("app");
    if (appEl) appEl.style.background = theme.colors.void;

    // 3. Push terminal colour mapping to Rust backend
    await this.syncTerminalColors(theme.terminalColors);

    // 4. Persist to config so we survive restarts
    await invoke("save_config", { key: "theme", value: themeName }).catch((err) => {
      console.warn("[ThemeManager] save_config failed:", err);
    });
  }

  // ── syncTerminalColors ─────────────────────────────────────────────────────
  // Sends the TerminalColors map as a JSON object to the Rust command.

  private async syncTerminalColors(tc: TerminalColors): Promise<void> {
    // Rust expects a flat object of key → [r, g, b] arrays
    const payload: Record<string, [number, number, number]> = {
      black:      tc.black,
      red:        tc.red,
      green:      tc.green,
      yellow:     tc.yellow,
      blue:       tc.blue,
      magenta:    tc.magenta,
      cyan:       tc.cyan,
      white:      tc.white,
      foreground: tc.foreground,
      background: tc.background,
      cursor:     tc.cursor,
    };

    await invoke("set_theme_colors", { colors: payload }).catch((err) => {
      console.warn("[ThemeManager] set_theme_colors failed:", err);
    });
  }

  /** Re-sync the current theme's terminal colors to the Rust backend.
   *  Called after creating a new session so it picks up the active palette. */
  async syncCurrentTheme(): Promise<void> {
    const theme = THEMES[this.currentName];
    if (theme) await this.syncTerminalColors(theme.terminalColors);
  }

  // ── loadSaved ──────────────────────────────────────────────────────────────
  // Called on startup — reads persisted theme from config and applies it.
  // Falls through to DEFAULT_THEME if no config exists yet.

  async loadSaved(): Promise<void> {
    try {
      const saved = await invoke<string>("load_config", { key: "theme" });
      const name = saved && THEMES[saved] ? saved : DEFAULT_THEME;
      await this.apply(name);
    } catch {
      // Config file not yet created — first boot, apply default silently
      await this.apply(DEFAULT_THEME);
    }
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

export const themeManager = new ThemeManager();
