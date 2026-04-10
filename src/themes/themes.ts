// themes.ts — Kōji Baseline theme palette definitions
// Six worlds, six glass filters. Pick your neon.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThemeColors {
  /** Near-black void — primary background */
  void: string;
  /** Brightest foreground — primary text highlight */
  bright: string;
  /** Warm mid-tone — default text */
  warm: string;
  /** Muted — secondary text, labels */
  muted: string;
  /** Faded — tertiary UI, dim separators */
  faded: string;
  /** Deep — subtle panel backgrounds */
  deep: string;
  /** Dim — inactive elements */
  dim: string;
  /** Accent — call-to-action, icons */
  accent: string;
  /** Error state colour */
  error: string;
  /** Success state colour */
  success: string;
  /** Glow — rgba ambient bloom */
  glow: string;
}

export interface TerminalColors {
  black:      [number, number, number];
  red:        [number, number, number];
  green:      [number, number, number];
  yellow:     [number, number, number];
  blue:       [number, number, number];
  magenta:    [number, number, number];
  cyan:       [number, number, number];
  white:      [number, number, number];
  foreground: [number, number, number];
  background: [number, number, number];
  cursor:     [number, number, number];
}

export interface Theme {
  name:        string;
  displayName: string;
  source:      string;
  colors:      ThemeColors;
  terminalColors: TerminalColors;
}

// ─── Theme Definitions ────────────────────────────────────────────────────────

export const THEMES: Record<string, Theme> = {

  // ── Wallace — Blade Runner 2049 amber ────────────────────────────────────────
  // Everything filtered through amber glass. The long city.
  wallace: {
    name:        "wallace",
    displayName: "Wallace",
    source:      "Blade Runner 2049",
    colors: {
      void:    "#0a0a0a",
      bright:  "#ff8c00",
      warm:    "#cc7a00",
      muted:   "#996b00",
      faded:   "#5a4a1a",
      deep:    "#3a2a10",
      dim:     "#4a3a1a",
      accent:  "#ff6a00",
      error:   "#ff4500",
      success: "#3a6a3a",
      glow:    "rgba(255, 106, 0, 0.3)",
    },
    terminalColors: {
      black:      [10,  10,  10],
      red:        [255, 69,  0],
      green:      [58,  106, 58],
      yellow:     [74,  58,  26],
      blue:       [204, 122, 0],
      magenta:    [255, 106, 0],
      cyan:       [153, 107, 0],
      white:      [204, 122, 0],
      foreground: [204, 122, 0],
      background: [10,  10,  10],
      cursor:     [255, 140, 0],
    },
  },

  // ── Tyrell — Blade Runner 1982 cold neon ─────────────────────────────────────
  // Acid rain, neon kanji, pyramid glow on wet streets.
  tyrell: {
    name:        "tyrell",
    displayName: "Tyrell",
    source:      "Blade Runner 1982",
    colors: {
      void:    "#0a0a12",
      bright:  "#00d4ff",
      warm:    "#00aacc",
      muted:   "#007799",
      faded:   "#1a3a4a",
      deep:    "#0a1a22",
      dim:     "#122233",
      accent:  "#ff2050",
      error:   "#ff2050",
      success: "#00aa55",
      glow:    "rgba(0, 212, 255, 0.25)",
    },
    terminalColors: {
      black:      [10,  10,  18],
      red:        [255, 32,  80],
      green:      [0,   170, 85],
      yellow:     [0,   170, 204],
      blue:       [0,   100, 160],
      magenta:    [180, 0,   200],
      cyan:       [0,   212, 255],
      white:      [0,   170, 204],
      foreground: [0,   170, 204],
      background: [10,  10,  18],
      cursor:     [0,   212, 255],
    },
  },

  // ── Baseline — Blade Runner 2049 lavender memory ──────────────────────────────
  // The baseline test. Cells, echoes, void lavender.
  baseline: {
    name:        "baseline",
    displayName: "Baseline",
    source:      "Blade Runner 2049",
    colors: {
      void:    "#08060e",
      bright:  "#c4a0ff",
      warm:    "#a080dd",
      muted:   "#7055aa",
      faded:   "#3a2a55",
      deep:    "#1a0e2e",
      dim:     "#2a1a44",
      accent:  "#e0e0e0",
      error:   "#ff4488",
      success: "#66aa88",
      glow:    "rgba(196, 160, 255, 0.2)",
    },
    terminalColors: {
      black:      [8,   6,   14],
      red:        [255, 68,  136],
      green:      [102, 170, 136],
      yellow:     [196, 160, 255],
      blue:       [112, 85,  170],
      magenta:    [200, 120, 255],
      cyan:       [140, 180, 220],
      white:      [224, 224, 224],
      foreground: [160, 128, 221],
      background: [8,   6,   14],
      cursor:     [196, 160, 255],
    },
  },

  // ── Netrunner — Cyberpunk 2077 chrome yellow ──────────────────────────────────
  // ICE-cold chrome on deep violet. Hack the planet.
  netrunner: {
    name:        "netrunner",
    displayName: "Netrunner",
    source:      "Cyberpunk 2077",
    colors: {
      void:    "#0a0612",
      bright:  "#fcee09",
      warm:    "#d4c800",
      muted:   "#998f00",
      faded:   "#3a3310",
      deep:    "#1a1608",
      dim:     "#2a2412",
      accent:  "#fcee09",
      error:   "#ff3030",
      success: "#00ee44",
      glow:    "rgba(252, 238, 9, 0.25)",
    },
    terminalColors: {
      black:      [10,  6,   18],
      red:        [255, 48,  48],
      green:      [0,   238, 68],
      yellow:     [252, 238, 9],
      blue:       [80,  40,  200],
      magenta:    [180, 80,  255],
      cyan:       [0,   220, 200],
      white:      [212, 200, 0],
      foreground: [212, 200, 0],
      background: [10,  6,   18],
      cursor:     [252, 238, 9],
    },
  },

  // ── Arasaka — Cyberpunk 2077 corp magenta/cyan ────────────────────────────────
  // Corporate fear in hot magenta. Loyalty until death.
  arasaka: {
    name:        "arasaka",
    displayName: "Arasaka",
    source:      "Cyberpunk 2077",
    colors: {
      void:    "#080510",
      bright:  "#ff00ff",
      warm:    "#cc00cc",
      muted:   "#880088",
      faded:   "#330033",
      deep:    "#160010",
      dim:     "#220022",
      accent:  "#00ffff",
      error:   "#ff0044",
      success: "#00ff88",
      glow:    "rgba(255, 0, 255, 0.2)",
    },
    terminalColors: {
      black:      [8,   5,   16],
      red:        [255, 0,   68],
      green:      [0,   255, 136],
      yellow:     [255, 160, 0],
      blue:       [0,   80,  255],
      magenta:    [255, 0,   255],
      cyan:       [0,   255, 255],
      white:      [204, 0,   204],
      foreground: [204, 0,   204],
      background: [8,   5,   16],
      cursor:     [255, 0,   255],
    },
  },

  // ── Militech — Cyberpunk 2077 military green ──────────────────────────────────
  // Spec-ops green. Amber intel on dark glass. No mercy.
  militech: {
    name:        "militech",
    displayName: "Militech",
    source:      "Cyberpunk 2077",
    colors: {
      void:    "#0a0c0a",
      bright:  "#00cc44",
      warm:    "#009933",
      muted:   "#006622",
      faded:   "#0a2a12",
      deep:    "#061408",
      dim:     "#0a1c0c",
      accent:  "#ccaa00",
      error:   "#dd2200",
      success: "#00cc44",
      glow:    "rgba(0, 204, 68, 0.2)",
    },
    terminalColors: {
      black:      [10,  12,  10],
      red:        [221, 34,  0],
      green:      [0,   204, 68],
      yellow:     [204, 170, 0],
      blue:       [0,   80,  120],
      magenta:    [80,  180, 60],
      cyan:       [0,   160, 100],
      white:      [0,   153, 51],
      foreground: [0,   153, 51],
      background: [10,  12,  10],
      cursor:     [0,   204, 68],
    },
  },

};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const THEME_NAMES = Object.keys(THEMES) as (keyof typeof THEMES)[];
export const DEFAULT_THEME = "wallace";
