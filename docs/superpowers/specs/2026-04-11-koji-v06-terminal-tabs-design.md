# Kōji Baseline v0.6 — Terminal Tabs

## Goal

Add multi-tab terminal support so users can run multiple shell sessions in one window. Each tab gets its own PTY, scrollback, and state. A "Linked" ASCII animation plays on new tab creation. The tab bar matches the existing Kōji theme system.

## Architecture

The current single-PTY architecture (one PtyManager + one TerminalEngine in Rust, one DOMGrid in TypeScript) becomes a multi-session system. Rust manages a map of sessions keyed by tab ID. The frontend maintains a tab bar and swaps the active DOMGrid when switching tabs. Each tab is fully isolated — its own PTY, engine, scrollback, and cursor state.

### Rust Backend

Replace the single `PtyState` and `EngineState` with a `SessionMap`:

```
SessionMap: Arc<Mutex<HashMap<String, Session>>>

struct Session {
    pty: PtyManager,
    engine: TerminalEngine,
    reader_thread: JoinHandle<()>,
}
```

New Tauri commands:
- `create_session(rows, cols) -> String` — spawns a new PTY + engine, returns session ID. Starts I/O thread that emits `terminal-output-{id}` and `scrollback-append-{id}` events.
- `close_session(id)` — drops the session (PTY, engine, thread).
- `write_to_session(id, data)` — write bytes to a specific PTY.
- `resize_session(id, rows, cols)` — resize a specific PTY.

The existing `init_terminal`, `write_to_pty`, `resize_terminal` commands are replaced by the session-scoped versions.

### Frontend

- `TabManager` class owns the tab bar DOM, tab state, and active tab switching.
- Each tab has: `{ id: string, name: string, grid: DOMGrid, mouse: MouseReporter, autocomplete: Autocomplete }`.
- Active tab's grid is visible; inactive tabs' grids are hidden (`display: none`).
- Event listeners (`terminal-output-{id}`, `scrollback-append-{id}`) are per-session.
- The agent pane, search, selection, and effects operate on the active tab's grid.

## Tab Bar

### Position
Below `dashboard-top`, above `.terminal-viewport`. 28px height strip.

### Layout
Horizontal row of tabs, scrollable if many tabs. `+` button pinned at the right end.

### Styling
- Bar: `--koji-void` background, `--koji-deep` bottom border
- Active tab: `--koji-bright` text, `--koji-deep` background, 2px `--koji-orange` accent line on top
- Inactive tab: `--koji-faded` text, transparent background, `--koji-dim` background on hover
- `+` button: `--koji-faded` default, `--koji-bright` on hover
- Close `×`: only visible on tab hover, `--koji-faded` default, `--koji-error` on hover

### Tab Names
Default: current working directory basename (from `cwd-changed` event). Updates as user `cd`s. Rename by double-clicking the tab label — shows an inline text input.

## "Linked" Animation

When a new tab is created:
1. PTY spawns immediately — keystrokes go to the shell during animation.
2. A centered ASCII art overlay renders "LINKED" in the `--koji-bright` color, same font as the terminal.
3. The overlay fades out over 1.5 seconds (CSS opacity transition).
4. The overlay is non-blocking — `pointer-events: none` during animation.

The ASCII art is simple block text, not elaborate — just "LINKED" in a clean monospace style. The animation is the same mechanism as the boot sequence but shorter and scoped to the new tab.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close active tab |
| Cmd+Shift+] | Next tab |
| Cmd+Shift+[ | Previous tab |
| Cmd+1 through Cmd+9 | Jump to tab by number |

## Tab Close Behaviour

- Each tab has a `×` button, visible on hover.
- Cmd+W closes the active tab.
- Closing the last tab auto-creates a new tab (never zero tabs, app stays open).
- No confirmation prompt — shell processes handle their own cleanup via SIGHUP.

## Agent Pane Interaction

The agent pane is a mode within a tab, not a separate tab. `/agent` splits the current tab's viewport. `/exit` restores it. Agent state is per-tab.

## Config

No new config keys needed. Tab state is ephemeral (not persisted across restarts).

## Files Changed

### New Files
- `src/tabs/tab-manager.ts` — Tab bar DOM, tab creation/closing/switching, keyboard shortcuts
- `src/tabs/tab-session.ts` — Per-tab state: grid, mouse, autocomplete, event listeners
- `src/tabs/linked-art.ts` — "LINKED" ASCII art and fade animation

### Modified Files (Rust)
- `src-tauri/src/lib.rs` — Replace single PTY/engine state with SessionMap, add session-scoped commands
- `src-tauri/src/pty.rs` — No changes (PtyManager already self-contained)
- `src-tauri/src/terminal.rs` — No changes (TerminalEngine already self-contained)

### Modified Files (TypeScript)
- `src/main.ts` — Replace single grid/mouse/autocomplete init with TabManager. Keyboard shortcuts delegated to TabManager.
- `src/styles/wallace.css` — Tab bar styles, linked animation styles
- `index.html` — Add tab bar container div between dashboard-top and terminal-viewport

### Modified Files (Adaptation)
- `src/agent/pane.ts` — Operate on active tab's grid instead of global `domGrid`
- `src/terminal/search.ts` — Operate on active tab's grid
- `src/terminal/selection.ts` — Operate on active tab's grid
- `src/animation/effects.ts` — Operate on active tab's grid
- `src/terminal/clickable.ts` — Operate on active tab's scroll element
