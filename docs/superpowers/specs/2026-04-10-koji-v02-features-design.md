# Kōji Baseline v0.2 Features — Design Specification

> Built-in slash commands, six-theme system (Blade Runner + Cyberpunk 2077), and clickable URLs/file paths.

## Overview

Three independent feature sets that elevate Kōji Baseline from a functional terminal to a workflow-enhancing daily driver. All features integrate with the existing Wallace aesthetic and respect the current architecture (Tauri v2, Canvas 2D renderer, Rust backend).

## Feature 1: Built-in Slash Commands

### Trigger

Any input starting with `/` is intercepted before reaching the shell. Processed internally, output renders inline in the terminal using the current theme's styling.

### Command Table

| Command | Action |
|---------|--------|
| `/help` | Show all available commands with descriptions |
| `/theme <name>` | Switch theme (wallace, tyrell, baseline, netrunner, arasaka, militech) |
| `/theme` | List available themes with current theme highlighted |
| `/llm connect` | Check Ollama connection status |
| `/llm model <name>` | Switch active LLM model |
| `/llm models` | List available Ollama models |
| `/llm pull <name>` | Pull a model from Ollama's library |
| `/version` | Show Kōji Baseline version |

### Output Rendering

Command output renders inline in the terminal flow (same position as shell output would appear). `/help` renders as a styled table matching the current theme — not raw text. Error output (e.g. Ollama offline) renders in the theme's error colour.

### Architecture

- Detection: `main.ts` keydown handler checks for `/` prefix on Enter, alongside existing `>>` detection
- Parsing: new `src/commands/router.ts` — parses the command string and dispatches to handler functions
- Handlers: new `src/commands/handlers.ts` — individual command implementations
- Backend commands (like `/llm pull`) call Tauri commands — `/llm pull` needs a new `ollama_pull(model)` command in `ollama.rs` that streams pull progress via events
- `/llm models` needs a new `ollama_list_models()` command that calls Ollama's `GET /api/tags` and returns model names
- Output rendered via the grid's LLM response panel (reused — renamed to "overlay panel")

## Feature 2: Theme System

### Six Themes

| Theme | Source | Primary | Accent | Background |
|-------|--------|---------|--------|------------|
| Wallace | BR 2049 | `#ff8c00` amber | `#ff6a00` orange | `#0a0a0a` |
| Tyrell | BR 1982 | `#00d4ff` cyan | `#ff2050` red | `#0a0a12` |
| Baseline | BR 2049 | `#c4a0ff` lavender | `#e0e0e0` white | `#08060e` |
| Netrunner | CP 2077 | `#fcee09` yellow | `#fcee09` yellow | `#0a0612` |
| Arasaka | CP 2077 | `#ff00ff` magenta | `#00ffff` cyan | `#080510` |
| Militech | CP 2077 | `#00cc44` green | `#ccaa00` amber | `#0a0c0a` |

### Theme Data Structure

Each theme is a TypeScript object:

```typescript
interface Theme {
  name: string;
  displayName: string;
  source: string; // "Blade Runner 2049", "Cyberpunk 2077", etc.
  colors: {
    void: string;       // background
    bright: string;     // user input, highlights
    warm: string;       // command output, default text
    muted: string;      // secondary text, metadata
    faded: string;      // separators, dim elements
    deep: string;       // near-invisible, borders
    dim: string;        // dividers
    accent: string;     // links, clickable elements, active glyphs
    error: string;      // error output
    success: string;    // success indicators
    glow: string;       // rgba glow effect
  };
  // Named terminal colours for the Rust backend
  terminalColors: {
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
  };
}
```

### What Changes Per Theme

- All CSS custom variables (`--koji-*`)
- Terminal grid default text colours (the Rust `named_to_rgb` mapping, sent via Tauri event)
- Cursor beam colour
- Boot sequence logo colour (reads from active theme)
- Scrollback fade target colour
- Waveform divider colour and glow
- Dashboard text colours

### What Stays the Same

- Layout structure (borderless viewport, top/bottom bars)
- Font (JetBrains Mono / Courier New)
- Animation behaviour and timing
- Application colours from tools (Claude Code, vim, etc.) render as-is

### Runtime Switching

`/theme <name>` triggers:
1. Update CSS variables on `:root` element
2. Emit `theme-changed` event to Rust backend with new `terminalColors`
3. Rust backend updates its `named_to_rgb()` mapping for future grid snapshots
4. Force a full grid redraw with new colours
5. Save preference to config file

### Persistence

Theme preference persists to `~/.koji-baseline/config.json`:
```json
{
  "theme": "wallace"
}
```

Loaded on app startup. Defaults to `"wallace"` if file doesn't exist.

## Feature 3: Clickable Elements

### Detection

After each grid render, a regex pass scans the visible terminal text for:

- **URLs:** `https?://[^\s]+`
- **Absolute paths:** `/[^\s]+` validated against filesystem
- **Home-relative paths:** `~/[^\s]+` resolved against `$HOME`
- **Relative paths:** `./[^\s]+` resolved against current working directory

### Validation

Detected paths are validated via a Tauri command `check_path_type(path)` which returns:
- `"directory"` — path exists and is a directory
- `"file"` — path exists and is a file
- `null` — path doesn't exist (not clickable)

Validation runs when the grid snapshot changes (debounced), not every frame. Only visible rows are scanned.

### Visual Treatment

- Clickable text renders in the theme's `accent` colour — slightly brighter than normal output
- On mouse hover: CSS-style underline drawn on the canvas, cursor changes to pointer via `canvas.style.cursor`
- On mouse leave: underline removed, cursor returns to default

### Click Actions

| Element | Action |
|---------|--------|
| URL | Open in default browser via Tauri shell API |
| Directory | Send `cd /path\r` to the PTY |
| File | Open with `$EDITOR` if set, otherwise `open /path` (macOS default) |

### Clickable Region Tracking

```typescript
interface ClickableRegion {
  row: number;
  colStart: number;
  colEnd: number;
  type: "url" | "directory" | "file";
  value: string; // the actual URL or resolved path
}
```

Stored as an array on the `TerminalGrid` class. Rebuilt on each grid snapshot change. Mouse events check against this array using the existing `getCellFromClick()` method.

### Edge Cases

- Paths with spaces: not detected (would require quote parsing — out of scope for v0.2)
- Multi-line URLs: not detected (single-line only)
- Only visible rows scanned, not scrollback
- Symlinks: resolved to their target for type checking

## Project Structure (New Files)

```
src/commands/
  router.ts        — parse "/" commands, dispatch to handlers
  handlers.ts      — individual command implementations
src/themes/
  themes.ts        — theme definitions (all 6 palettes)
  manager.ts       — runtime switching, CSS updates, persistence
src/terminal/
  clickable.ts     — URL/path detection, region tracking, hover/click
```

## Non-Goals (v0.2)

- Command palette (`Cmd+K`) — future feature
- Tabs / split panes — future feature
- Smart tab completion via LLM — future feature
- Session recording — future feature
- Image preview — future feature
- Notification sounds — future feature
