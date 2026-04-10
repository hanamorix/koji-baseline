# Kōji Baseline v0.2 Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add slash commands (`/help`, `/theme`, `/llm`), six switchable themes (Blade Runner + Cyberpunk 2077), and clickable URLs/file paths to the Kōji Baseline terminal emulator.

**Architecture:** Theme definitions are pure data objects that drive CSS variable updates and Rust-side colour mappings via IPC events. Slash commands are intercepted in `main.ts` (alongside existing `>>` detection) and dispatched to handler functions. Clickable regions are detected via regex on each grid snapshot and rendered as a hover overlay on the Canvas.

**Tech Stack:** TypeScript (frontend), Rust (backend Tauri commands), Canvas 2D API, CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-04-10-koji-v02-features-design.md`

**Project location:** `/Users/hanamori/koji-baseline/`

---

## Feature A: Theme System

### Task 1: Theme Definitions

**Files:**
- Create: `src/themes/themes.ts`

- [ ] **Step 1: Create the Theme interface and all six palettes**

Create `src/themes/themes.ts`:

```typescript
export interface ThemeColors {
  void: string;
  bright: string;
  warm: string;
  muted: string;
  faded: string;
  deep: string;
  dim: string;
  accent: string;
  error: string;
  success: string;
  glow: string;
}

export interface TerminalColors {
  black: [number, number, number];
  red: [number, number, number];
  green: [number, number, number];
  yellow: [number, number, number];
  blue: [number, number, number];
  magenta: [number, number, number];
  cyan: [number, number, number];
  white: [number, number, number];
  foreground: [number, number, number];
  background: [number, number, number];
  cursor: [number, number, number];
}

export interface Theme {
  name: string;
  displayName: string;
  source: string;
  colors: ThemeColors;
  terminalColors: TerminalColors;
}

export const THEMES: Record<string, Theme> = {
  wallace: {
    name: "wallace",
    displayName: "Wallace",
    source: "Blade Runner 2049",
    colors: {
      void: "#0a0a0a",
      bright: "#ff8c00",
      warm: "#cc7a00",
      muted: "#996b00",
      faded: "#5a4a1a",
      deep: "#3a2a10",
      dim: "#4a3a1a",
      accent: "#ff6a00",
      error: "#ff4500",
      success: "#3a6a3a",
      glow: "rgba(255, 106, 0, 0.3)",
    },
    terminalColors: {
      black: [10, 10, 10],
      red: [255, 69, 0],
      green: [58, 106, 58],
      yellow: [255, 140, 0],
      blue: [204, 122, 0],
      magenta: [255, 106, 0],
      cyan: [153, 107, 0],
      white: [204, 122, 0],
      foreground: [204, 122, 0],
      background: [10, 10, 10],
      cursor: [255, 140, 0],
    },
  },
  tyrell: {
    name: "tyrell",
    displayName: "Tyrell",
    source: "Blade Runner (1982)",
    colors: {
      void: "#0a0a12",
      bright: "#00d4ff",
      warm: "#8899aa",
      muted: "#4a5a6a",
      faded: "#3a3a4a",
      deep: "#1a1a2a",
      dim: "#2a2a3a",
      accent: "#ff2050",
      error: "#ff2050",
      success: "#00cc66",
      glow: "rgba(0, 212, 255, 0.3)",
    },
    terminalColors: {
      black: [10, 10, 18],
      red: [255, 32, 80],
      green: [0, 204, 102],
      yellow: [0, 212, 255],
      blue: [88, 136, 170],
      magenta: [255, 32, 80],
      cyan: [0, 212, 255],
      white: [136, 153, 170],
      foreground: [136, 153, 170],
      background: [10, 10, 18],
      cursor: [0, 212, 255],
    },
  },
  baseline: {
    name: "baseline",
    displayName: "Baseline",
    source: "Blade Runner 2049",
    colors: {
      void: "#08060e",
      bright: "#c4a0ff",
      warm: "#9a8aaa",
      muted: "#5a4a6a",
      faded: "#3a2a4a",
      deep: "#1a1020",
      dim: "#2a1a3a",
      accent: "#e0e0e0",
      error: "#ff6688",
      success: "#66aa88",
      glow: "rgba(196, 160, 255, 0.3)",
    },
    terminalColors: {
      black: [8, 6, 14],
      red: [255, 102, 136],
      green: [102, 170, 136],
      yellow: [196, 160, 255],
      blue: [154, 138, 170],
      magenta: [196, 160, 255],
      cyan: [224, 224, 224],
      white: [154, 138, 170],
      foreground: [154, 138, 170],
      background: [8, 6, 14],
      cursor: [196, 160, 255],
    },
  },
  netrunner: {
    name: "netrunner",
    displayName: "Netrunner",
    source: "Cyberpunk 2077",
    colors: {
      void: "#0a0612",
      bright: "#fcee09",
      warm: "#e0d86a",
      muted: "#8a7a2a",
      faded: "#4a4a1a",
      deep: "#1a1a08",
      dim: "#3a3a10",
      accent: "#fcee09",
      error: "#ff3a3a",
      success: "#44cc44",
      glow: "rgba(252, 238, 9, 0.3)",
    },
    terminalColors: {
      black: [10, 6, 18],
      red: [255, 58, 58],
      green: [68, 204, 68],
      yellow: [252, 238, 9],
      blue: [224, 216, 106],
      magenta: [252, 238, 9],
      cyan: [160, 152, 48],
      white: [224, 216, 106],
      foreground: [224, 216, 106],
      background: [10, 6, 18],
      cursor: [252, 238, 9],
    },
  },
  arasaka: {
    name: "arasaka",
    displayName: "Arasaka",
    source: "Cyberpunk 2077",
    colors: {
      void: "#080510",
      bright: "#ff00ff",
      warm: "#da70d6",
      muted: "#8a4a8a",
      faded: "#4a2a4a",
      deep: "#1a0a1a",
      dim: "#3a1a3a",
      accent: "#00ffff",
      error: "#ff4444",
      success: "#00ff7f",
      glow: "rgba(255, 0, 255, 0.3)",
    },
    terminalColors: {
      black: [8, 5, 16],
      red: [255, 68, 68],
      green: [0, 255, 127],
      yellow: [255, 0, 255],
      blue: [218, 112, 214],
      magenta: [255, 0, 255],
      cyan: [0, 255, 255],
      white: [218, 112, 214],
      foreground: [218, 112, 214],
      background: [8, 5, 16],
      cursor: [0, 255, 255],
    },
  },
  militech: {
    name: "militech",
    displayName: "Militech",
    source: "Cyberpunk 2077",
    colors: {
      void: "#0a0c0a",
      bright: "#00cc44",
      warm: "#88aa88",
      muted: "#4a5a4a",
      faded: "#2a3a2a",
      deep: "#1a2a1a",
      dim: "#2a3a2a",
      accent: "#ccaa00",
      error: "#ff4444",
      success: "#ccaa00",
      glow: "rgba(0, 204, 68, 0.3)",
    },
    terminalColors: {
      black: [10, 12, 10],
      red: [255, 68, 68],
      green: [204, 170, 0],
      yellow: [0, 204, 68],
      blue: [136, 170, 136],
      magenta: [0, 204, 68],
      cyan: [136, 170, 136],
      white: [136, 170, 136],
      foreground: [136, 170, 136],
      background: [10, 12, 10],
      cursor: [0, 204, 68],
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = "wallace";
```

- [ ] **Step 2: Commit**

```bash
git add src/themes/themes.ts
git commit -m "feat: define six theme palettes — Wallace, Tyrell, Baseline, Netrunner, Arasaka, Militech"
```

---

### Task 2: Theme Manager — Runtime Switching & Persistence

**Files:**
- Create: `src/themes/manager.ts`
- Modify: `src/main.ts`
- Modify: `src-tauri/src/terminal.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the theme manager**

Create `src/themes/manager.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { Theme, THEMES, DEFAULT_THEME } from "./themes";

class ThemeManager {
  private current: Theme;

  constructor() {
    this.current = THEMES[DEFAULT_THEME];
  }

  getCurrent(): Theme {
    return this.current;
  }

  getCurrentName(): string {
    return this.current.name;
  }

  /** Switch theme at runtime — updates CSS vars, notifies backend, saves preference */
  async apply(themeName: string): Promise<boolean> {
    const theme = THEMES[themeName];
    if (!theme) return false;

    this.current = theme;

    // Update CSS custom properties on :root
    const root = document.documentElement;
    root.style.setProperty("--koji-void", theme.colors.void);
    root.style.setProperty("--koji-bright", theme.colors.bright);
    root.style.setProperty("--koji-warm", theme.colors.warm);
    root.style.setProperty("--koji-muted", theme.colors.muted);
    root.style.setProperty("--koji-faded", theme.colors.faded);
    root.style.setProperty("--koji-deep", theme.colors.deep);
    root.style.setProperty("--koji-dim", theme.colors.dim);
    root.style.setProperty("--koji-orange", theme.colors.accent);
    root.style.setProperty("--koji-error", theme.colors.error);
    root.style.setProperty("--koji-success", theme.colors.success);
    root.style.setProperty("--koji-glow", theme.colors.glow);

    // Update body/app background directly for immediate effect
    document.body.style.background = theme.colors.void;
    const app = document.getElementById("app");
    if (app) app.style.background = theme.colors.void;

    // Notify Rust backend to update terminal colour mapping
    await invoke("set_theme_colors", {
      colors: theme.terminalColors,
    }).catch(() => {
      // Non-fatal — terminal colours will update on next snapshot
    });

    // Persist preference
    await invoke("save_config", {
      key: "theme",
      value: themeName,
    }).catch(() => {});

    return true;
  }

  /** Load saved theme preference on startup */
  async loadSaved(): Promise<void> {
    try {
      const saved = await invoke<string>("load_config", { key: "theme" });
      if (saved && THEMES[saved]) {
        await this.apply(saved);
      }
    } catch {
      // No saved config — use default
    }
  }
}

export const themeManager = new ThemeManager();
```

- [ ] **Step 2: Add config persistence and theme colour commands to Rust backend**

Add to `src-tauri/src/lib.rs`:

```rust
/// Update the terminal engine's named colour mapping at runtime.
#[tauri::command]
fn set_theme_colors(
    colors: serde_json::Value,
    engine_state: State<'_, EngineState>,
) -> Result<(), String> {
    let mut eng_opt = engine_state.0.lock().unwrap();
    if let Some(ref mut eng) = *eng_opt {
        eng.set_theme_colors(&colors);
    }
    Ok(())
}

/// Save a config key/value to ~/.koji-baseline/config.json
#[tauri::command]
fn save_config(key: String, value: String) -> Result<(), String> {
    let config_dir = dirs::home_dir()
        .ok_or("No home dir")?
        .join(".koji-baseline");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

    let config_path = config_dir.join("config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let data = std::fs::read_to_string(&config_path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    config[&key] = serde_json::Value::String(value);
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| e.to_string())
}

/// Load a config value from ~/.koji-baseline/config.json
#[tauri::command]
fn load_config(key: String) -> Result<String, String> {
    let config_path = dirs::home_dir()
        .ok_or("No home dir")?
        .join(".koji-baseline")
        .join("config.json");

    if !config_path.exists() {
        return Err("No config file".into());
    }

    let data = std::fs::read_to_string(&config_path).map_err(|e| e.to_string())?;
    let config: serde_json::Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;

    config[&key]
        .as_str()
        .map(String::from)
        .ok_or("Key not found".into())
}
```

Register all three commands in the `invoke_handler` macro.

- [ ] **Step 3: Add `set_theme_colors` to terminal engine**

Add to `src-tauri/src/terminal.rs` on the `TerminalEngine` impl:

```rust
/// Update named colour mapping at runtime — called when the user switches themes.
pub fn set_theme_colors(&mut self, colors: &serde_json::Value) {
    // Store the colour overrides — they'll be used by cell_to_render
    // on the next snapshot call. The actual mapping update happens
    // through a thread-local or by storing overrides in self.
    // For simplicity, store as a hashmap of name → [r,g,b].
    if let Some(obj) = colors.as_object() {
        for (key, val) in obj {
            if let Some(arr) = val.as_array() {
                if arr.len() == 3 {
                    let r = arr[0].as_u64().unwrap_or(0) as u8;
                    let g = arr[1].as_u64().unwrap_or(0) as u8;
                    let b = arr[2].as_u64().unwrap_or(0) as u8;
                    self.color_overrides.insert(key.clone(), [r, g, b]);
                }
            }
        }
    }
}
```

Add `color_overrides: std::collections::HashMap<String, [u8; 3]>` field to `TerminalEngine` struct, initialize as `HashMap::new()` in `new()`.

Update `named_to_rgb()` to check `color_overrides` first. This requires making it a method on `TerminalEngine` instead of a free function, or passing the overrides map into `cell_to_render()`.

- [ ] **Step 4: Wire theme manager into main.ts**

Add to `src/main.ts` at the top of the boot sequence:

```typescript
import { themeManager } from "./themes/manager";

// Load saved theme before anything renders
await themeManager.loadSaved();
```

- [ ] **Step 5: Verify it compiles**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: theme manager — runtime switching, CSS updates, backend colour mapping, config persistence"
```

---

## Feature B: Slash Commands

### Task 3: Command Router & Handlers

**Files:**
- Create: `src/commands/router.ts`
- Create: `src/commands/handlers.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Create the command router**

Create `src/commands/router.ts`:

```typescript
import { handleHelp, handleTheme, handleLlm, handleVersion } from "./handlers";

export interface CommandResult {
  output: string;
  isError: boolean;
}

/**
 * Parse and dispatch a slash command. Returns null if the input
 * is not a recognized command (fall through to shell).
 */
export function dispatchCommand(input: string): Promise<CommandResult> | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
      return handleHelp();
    case "theme":
      return handleTheme(args);
    case "llm":
      return handleLlm(args);
    case "version":
      return handleVersion();
    default:
      return Promise.resolve({
        output: `Unknown command: /${cmd}\nType /help for available commands.`,
        isError: true,
      });
  }
}
```

- [ ] **Step 2: Create the command handlers**

Create `src/commands/handlers.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { CommandResult } from "./router";
import { themeManager } from "../themes/manager";
import { THEMES, THEME_NAMES } from "../themes/themes";

export async function handleHelp(): Promise<CommandResult> {
  const lines = [
    "┌─────────────────────────────────────────────────┐",
    "│          Kōji Baseline — Commands                │",
    "├─────────────────────────────────────────────────┤",
    "│  /help                 Show this help            │",
    "│  /version              Show version              │",
    "│  /theme                List available themes      │",
    "│  /theme <name>         Switch theme               │",
    "│  /llm connect          Check Ollama status        │",
    "│  /llm model <name>     Switch LLM model           │",
    "│  /llm models           List available models      │",
    "│  /llm pull <name>      Pull a model from Ollama   │",
    "│  >> <question>         Ask the LLM inline         │",
    "└─────────────────────────────────────────────────┘",
  ];
  return { output: lines.join("\n"), isError: false };
}

export async function handleTheme(args: string[]): Promise<CommandResult> {
  if (args.length === 0) {
    // List themes
    const current = themeManager.getCurrentName();
    const lines = THEME_NAMES.map((name) => {
      const theme = THEMES[name];
      const marker = name === current ? " ◉" : "  ";
      return `${marker} ${theme.displayName.padEnd(12)} — ${theme.source}`;
    });
    return { output: lines.join("\n"), isError: false };
  }

  const themeName = args[0].toLowerCase();
  const success = await themeManager.apply(themeName);
  if (success) {
    const theme = THEMES[themeName];
    return {
      output: `Theme switched to ${theme.displayName} (${theme.source})`,
      isError: false,
    };
  }

  return {
    output: `Unknown theme: ${themeName}\nAvailable: ${THEME_NAMES.join(", ")}`,
    isError: true,
  };
}

export async function handleLlm(args: string[]): Promise<CommandResult> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "connect") {
    const status = await invoke<{ model: string; state: string }>("check_ollama");
    const icon = status.state === "ready" ? "●" : "○";
    return {
      output: `Ollama: ${icon} ${status.state}\nModel:  ${status.model}`,
      isError: status.state !== "ready",
    };
  }

  if (sub === "model" && args[1]) {
    await invoke("switch_model", { model: args[1] });
    return { output: `Model switched to ${args[1]}`, isError: false };
  }

  if (sub === "models") {
    try {
      const models = await invoke<string[]>("ollama_list_models");
      if (models.length === 0) {
        return { output: "No models found. Use /llm pull <name> to download one.", isError: false };
      }
      return { output: models.map((m) => `  ${m}`).join("\n"), isError: false };
    } catch (e) {
      return { output: `Failed to list models: ${e}`, isError: true };
    }
  }

  if (sub === "pull" && args[1]) {
    try {
      await invoke("ollama_pull_model", { model: args[1] });
      return { output: `Pulling ${args[1]}... (check Ollama logs for progress)`, isError: false };
    } catch (e) {
      return { output: `Failed to pull model: ${e}`, isError: true };
    }
  }

  return {
    output: "Usage: /llm [connect|model <name>|models|pull <name>]",
    isError: true,
  };
}

export async function handleVersion(): Promise<CommandResult> {
  return { output: "Kōji Baseline v0.2.0", isError: false };
}
```

- [ ] **Step 3: Add Ollama list/pull commands to Rust backend**

Add to `src-tauri/src/ollama.rs` on the `OllamaClient` impl:

```rust
/// GET /api/tags — return list of model names
pub async fn list_models(&self) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", self.base_url);
    let resp = self.client.get(&url).send().await
        .map_err(|e| format!("Ollama request failed: {e}"))?;
    let body: serde_json::Value = resp.json().await
        .map_err(|e| format!("JSON parse failed: {e}"))?;
    let models = body["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// POST /api/pull — trigger model download (fire and forget)
pub async fn pull_model(&self, model: &str) -> Result<(), String> {
    let url = format!("{}/api/pull", self.base_url);
    let body = serde_json::json!({ "name": model, "stream": false });
    self.client.post(&url).json(&body).send().await
        .map_err(|e| format!("Ollama pull failed: {e}"))?;
    Ok(())
}
```

Add Tauri commands in `lib.rs`:

```rust
#[tauri::command]
async fn ollama_list_models(state: State<'_, OllamaState>) -> Result<Vec<String>, String> {
    let client = state.0.lock().await;
    client.list_models().await
}

#[tauri::command]
async fn ollama_pull_model(model: String, state: State<'_, OllamaState>) -> Result<(), String> {
    let client = state.0.lock().await;
    client.pull_model(&model).await
}
```

Register both in `invoke_handler`.

- [ ] **Step 4: Wire slash commands into main.ts**

In `src/main.ts`, update the keydown handler to detect `/` prefix:

```typescript
import { dispatchCommand } from "./commands/router";
```

In the Enter key handling section, add before the `>>` check:

```typescript
if (line.startsWith("/")) {
  event.preventDefault();
  effects?.commandSubmit();
  const result = dispatchCommand(line);
  if (result) {
    const { output, isError } = await result;
    // Display output inline using the grid overlay
    const snap = grid.getLastSnapshot();
    if (snap) {
      grid.setLlmResponse(output, true, snap.cursor.row);
    }
  }
  currentInput = "";
  return;
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: slash commands — /help, /theme, /llm, /version with Ollama list/pull"
```

---

## Feature C: Clickable Elements

### Task 4: Clickable Region Detection

**Files:**
- Create: `src/terminal/clickable.ts`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the clickable detection module**

Create `src/terminal/clickable.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";

export interface ClickableRegion {
  row: number;
  colStart: number;
  colEnd: number;
  type: "url" | "directory" | "file";
  value: string;
}

const URL_REGEX = /https?:\/\/[^\s)>\]]+/g;
const ABS_PATH_REGEX = /(?:^|\s)(\/[^\s]+)/g;
const HOME_PATH_REGEX = /(?:^|\s)(~\/[^\s]+)/g;
const REL_PATH_REGEX = /(?:^|\s)(\.\/[^\s]+)/g;

/**
 * Scan a single row of terminal text for clickable regions.
 * Returns regions with column offsets.
 */
function scanRow(text: string, row: number): ClickableRegion[] {
  const regions: ClickableRegion[] = [];

  // URLs — always clickable, no filesystem check needed
  for (const match of text.matchAll(URL_REGEX)) {
    if (match.index === undefined) continue;
    regions.push({
      row,
      colStart: match.index,
      colEnd: match.index + match[0].length - 1,
      type: "url",
      value: match[0],
    });
  }

  // File paths — need async validation, added in validateRegions()
  for (const regex of [ABS_PATH_REGEX, HOME_PATH_REGEX, REL_PATH_REGEX]) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue;
      const path = match[1]; // captured group (without leading space)
      const offset = match[0].indexOf(path);
      regions.push({
        row,
        colStart: match.index + offset,
        colEnd: match.index + offset + path.length - 1,
        type: "file", // will be updated to "directory" after validation
        value: path,
      });
    }
  }

  return regions;
}

/**
 * Extract text from a grid snapshot row — concatenate all cell characters.
 */
function rowToText(cells: Array<{ character: string }>): string {
  return cells.map((c) => c.character || " ").join("");
}

/**
 * Scan the entire visible grid for clickable regions.
 * Validates paths against the filesystem (async).
 */
export async function detectClickableRegions(
  grid: Array<Array<{ character: string }>>,
  cwd: string,
): Promise<ClickableRegion[]> {
  const allRegions: ClickableRegion[] = [];

  for (let row = 0; row < grid.length; row++) {
    const text = rowToText(grid[row]);
    const regions = scanRow(text, row);
    allRegions.push(...regions);
  }

  // Validate file paths against filesystem
  const validated: ClickableRegion[] = [];
  for (const region of allRegions) {
    if (region.type === "url") {
      validated.push(region);
      continue;
    }

    // Resolve path
    let resolvedPath = region.value;
    if (resolvedPath.startsWith("~/")) {
      // Home expansion handled by backend
    } else if (resolvedPath.startsWith("./")) {
      resolvedPath = `${cwd}/${resolvedPath.slice(2)}`;
    }

    try {
      const pathType = await invoke<string | null>("check_path_type", {
        path: resolvedPath,
      });
      if (pathType === "directory") {
        validated.push({ ...region, type: "directory", value: resolvedPath });
      } else if (pathType === "file") {
        validated.push({ ...region, type: "file", value: resolvedPath });
      }
      // null = doesn't exist, skip
    } catch {
      // Skip invalid paths
    }
  }

  return validated;
}

/**
 * Find which clickable region (if any) contains the given cell coordinate.
 */
export function findRegionAt(
  regions: ClickableRegion[],
  row: number,
  col: number,
): ClickableRegion | null {
  for (const r of regions) {
    if (r.row === row && col >= r.colStart && col <= r.colEnd) {
      return r;
    }
  }
  return null;
}
```

- [ ] **Step 2: Add path checking command to Rust backend**

Add to `src-tauri/src/lib.rs`:

```rust
/// Check if a path exists and return its type: "file", "directory", or null.
#[tauri::command]
fn check_path_type(path: String) -> Option<String> {
    // Expand ~ to home dir
    let expanded = if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&path[2..])
        } else {
            std::path::PathBuf::from(&path)
        }
    } else {
        std::path::PathBuf::from(&path)
    };

    match std::fs::metadata(&expanded) {
        Ok(meta) if meta.is_dir() => Some("directory".to_string()),
        Ok(meta) if meta.is_file() => Some("file".to_string()),
        _ => None,
    }
}
```

Register in `invoke_handler`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: clickable region detection — URL/path scanning with filesystem validation"
```

---

### Task 5: Clickable Rendering & Interaction

**Files:**
- Modify: `src/terminal/grid.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Add clickable region rendering to the grid**

Add to `TerminalGrid` class in `src/terminal/grid.ts`:

```typescript
import { ClickableRegion, findRegionAt } from "./clickable";

// Add fields:
private clickableRegions: ClickableRegion[] = [];
private hoveredRegion: ClickableRegion | null = null;

// Add methods:

setClickableRegions(regions: ClickableRegion[]): void {
  this.clickableRegions = regions;
}

setHoveredRegion(region: ClickableRegion | null): void {
  this.hoveredRegion = region;
  this.canvas.style.cursor = region ? "pointer" : "default";
  // Trigger redraw to show/hide underline
  if (this.lastSnapshot) {
    this.drawGrid(this.lastSnapshot);
  }
}
```

In `drawGrid()`, after drawing each cell's character, check if the cell is in a clickable region. If so, draw it in the theme's accent colour instead of the normal fg colour. If the region is hovered, draw an underline.

Add this after the character drawing block in the cell loop:

```typescript
// Check if this cell is in a clickable region
const region = findRegionAt(this.clickableRegions, row, col);
if (region) {
  // Override foreground to accent colour
  // Re-draw the character in accent colour
  const accentColor = getComputedStyle(document.documentElement)
    .getPropertyValue("--koji-orange").trim();
  if (cell.character && cell.character.trim() !== "") {
    // Clear the cell area and redraw with accent colour
    ctx.fillStyle = rgbToHex(cell.bg);
    ctx.fillRect(x, y, CELL_WIDTH, CELL_HEIGHT);
    ctx.fillStyle = accentColor || "#ff6a00";
    ctx.font = buildFont(cell.bold, cell.italic);
    ctx.fillText(cell.character, x, y + 1);
  }

  // Underline on hover
  if (this.hoveredRegion && this.hoveredRegion.row === row
      && col >= this.hoveredRegion.colStart && col <= this.hoveredRegion.colEnd) {
    ctx.fillStyle = accentColor || "#ff6a00";
    ctx.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH, 1);
  }
}
```

- [ ] **Step 2: Wire mouse events and click actions in main.ts**

Add to `src/main.ts`:

```typescript
import { detectClickableRegions, findRegionAt } from "./terminal/clickable";

// After grid is created, add mouse handlers:

// Track current CWD for path resolution
let currentCwd = "~/";
listen<{ path: string }>("cwd-changed", (event) => {
  currentCwd = event.payload.path;
});

// Detect clickable regions on each grid update
listen<GridSnapshot>("terminal-output", async (event) => {
  grid.render(event.payload);
  // Debounce clickable detection — don't run every frame
  clearTimeout(clickableTimer);
  clickableTimer = window.setTimeout(async () => {
    const regions = await detectClickableRegions(event.payload.cells, currentCwd);
    grid.setClickableRegions(regions);
  }, 200);
});

let clickableTimer: number = 0;

// Hover detection
grid.getCanvas().addEventListener("mousemove", (e) => {
  const cell = grid.getCellFromClick(e);
  if (!cell) return;
  const region = findRegionAt(grid.getClickableRegions(), cell.row, cell.col);
  grid.setHoveredRegion(region);
});

grid.getCanvas().addEventListener("mouseleave", () => {
  grid.setHoveredRegion(null);
});

// Click handling
grid.getCanvas().addEventListener("click", async (e) => {
  const cell = grid.getCellFromClick(e);
  if (!cell) return;
  const region = findRegionAt(grid.getClickableRegions(), cell.row, cell.col);
  if (!region) return;

  if (region.type === "url") {
    // Open URL in default browser
    await invoke("open_url", { url: region.value });
  } else if (region.type === "directory") {
    // cd into the directory
    const cmd = `cd ${region.value}\r`;
    const bytes = Array.from(new TextEncoder().encode(cmd));
    await invoke("write_to_pty", { data: bytes });
  } else if (region.type === "file") {
    // Open file in editor
    await invoke("open_file", { path: region.value });
  }
});
```

Add a `getClickableRegions()` getter to `TerminalGrid`.

- [ ] **Step 3: Add URL/file open commands to Rust backend**

Add to `src-tauri/src/lib.rs`:

```rust
/// Open a URL in the default browser
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

/// Open a file in $EDITOR or the macOS default handler
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    // Expand ~ to home dir
    let expanded = if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            home.join(&path[2..]).to_string_lossy().to_string()
        } else {
            path.clone()
        }
    } else {
        path.clone()
    };

    if let Ok(editor) = std::env::var("EDITOR") {
        // Open in $EDITOR — spawn detached
        std::process::Command::new(&editor)
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to open in {editor}: {e}"))?;
    } else {
        // Fallback to macOS `open`
        std::process::Command::new("open")
            .arg(&expanded)
            .spawn()
            .map_err(|e| format!("Failed to open file: {e}"))?;
    }
    Ok(())
}
```

Register both in `invoke_handler`.

- [ ] **Step 4: Verify it compiles**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: clickable URLs and file paths — accent colour, hover underline, click-to-open"
```

---

## Final Integration

### Task 6: Final Build & Version Bump

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`

- [ ] **Step 1: Bump version to 0.2.0**

Update version in:
- `src-tauri/tauri.conf.json`: `"version": "0.2.0"`
- `src-tauri/Cargo.toml`: `version = "0.2.0"`
- `package.json`: `"version": "0.2.0"`

- [ ] **Step 2: Add `.koji-baseline/` to .gitignore**

```bash
echo ".koji-baseline/" >> .gitignore
```

(This is the config directory created by the theme manager.)

- [ ] **Step 3: Production build**

```bash
npm run tauri build
```

Expected: Builds `.app` and `.dmg` successfully.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: Kōji Baseline v0.2.0 — themes, slash commands, clickable paths"
```

---

## Task Dependency Summary

```
Task 1 (Theme defs) → Task 2 (Theme manager)
                              ↓
Task 3 (Slash commands) — depends on Task 2 for /theme
                              ↓
Task 4 (Clickable detection) → Task 5 (Clickable rendering)
                                          ↓
                                   Task 6 (Final build)
```

Tasks 1→2 and 4→5 are two independent streams that merge at Task 3 (which needs theme manager for `/theme` command). Task 6 depends on everything.
