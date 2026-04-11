# Koji Baseline

A cyberpunk terminal emulator for macOS with native AI integration. Built with Tauri, Rust, and TypeScript.

Koji is an AI-native terminal — not a terminal with AI bolted on. Local LLM integration via Ollama means your commands, output, and context never leave your machine.

## Features

### Terminal

- **Split panes** — Cmd+D (right), Cmd+Shift+D (down), draggable dividers, pane zoom
- **Shell integration** — OSC 7 (CWD tracking), OSC 133 (semantic zones), auto-injected for zsh/bash/fish
- **Command blocks** — each command + output grouped as a collapsible, copyable block
- **Multi-tab** — Cmd+T/W, tab drag reorder, pane count badges, CWD-based tab names
- **Session restore** — tabs and CWDs persist across app restarts
- **Quick terminal** — Cmd+\` visor drops down from the top of the screen
- **Full VT100/ANSI** — truecolor, 256-color, alt screen, mouse reporting (SGR), bracketed paste
- **Scrollback search** — Cmd+F with match navigation
- **Clickable URLs** — hover underline, click to open
- **OSC 52 clipboard** — copy/paste works over SSH
- **Synchronized rendering** — DCS mode 2026 prevents tearing during heavy output

### AI Integration

- **Command blocks with error diagnosis** — failed commands auto-diagnosed by local Ollama, inline fix suggestions with one-click execution
- **Inline suggestions** — ghost-text completions from command history
- **Semantic history search** — Ctrl+R searches history by meaning, not just text
- **Agent pane** — full tool-use agent with file read/write/edit, shell commands, web fetch
- **Inline LLM queries** — type `>> your question` for instant answers
- **Local-first** — Ollama + any OpenAI-compatible provider. No cloud required. No telemetry.

### Configuration

- **TOML config** — `~/.koji-baseline/config.toml` with hot reload on save
- **Configurable keybindings** — remap every shortcut in your config file
- **Command palette** — Cmd+Shift+P for fuzzy-filtered action list
- **6 cyberpunk themes** — Wallace, Neon, Void, Ember, Frost, Sakura
- **4 bundled fonts** — JetBrains Mono, Fira Code, Cascadia Code, Iosevka
- **Cursor styles** — block, beam, underline

### macOS Native

- **Secure keyboard entry** — prevents keystroke interception when typing passwords
- **Process notifications** — long-running commands notify when app is backgrounded
- **Proxy icon** — CWD path in tab bar
- **ARIA accessibility** — screen reader labels on all interactive elements

## Install

### From DMG (recommended)

Download the latest `.dmg` from [Releases](https://github.com/hanamori/koji-baseline/releases), open it, drag to Applications.

### From Source

Requirements: Node.js 18+, Rust 1.75+, macOS 14+

```bash
git clone https://github.com/hanamori/koji-baseline.git
cd koji-baseline
npm install
npx tauri build
```

The built app is at `src-tauri/target/release/bundle/macos/Koji Baseline.app`.

## Development

```bash
npm run dev          # Vite dev server + Tauri hot reload
npm run build        # Build frontend only
npx tauri build      # Full production build (.app + .dmg)
```

Run tests:

```bash
cd src-tauri && cargo test    # 30 Rust tests
npx tsc --noEmit              # TypeScript type check
```

## Configuration

On first launch, Koji creates `~/.koji-baseline/config.toml`:

```toml
[terminal]
theme = "wallace"
font = "JetBrains Mono"
font_size = 14
cursor_style = "block"
shell_integration = true

[notifications]
enabled = true
min_duration_seconds = 10

[ai]
auto_diagnose = true
suggest_enabled = true
blocks_enabled = true

[keybindings]
new_tab = "cmd+t"
close_tab = "cmd+w"
split_right = "cmd+d"
split_down = "cmd+shift+d"
palette = "cmd+shift+p"
# ... see default-config.toml for full list
```

Edit and save — changes apply immediately, no restart needed.

## Keyboard Shortcuts

| Action | Default | Configurable |
|--------|---------|:---:|
| New tab | Cmd+T | Yes |
| Close tab | Cmd+W | Yes |
| Close pane | Cmd+Shift+W | Yes |
| Split right | Cmd+D | Yes |
| Split down | Cmd+Shift+D | Yes |
| Navigate panes | Cmd+Option+Arrow | Yes |
| Zoom pane | Cmd+Shift+Enter | Yes |
| Command palette | Cmd+Shift+P | Yes |
| Search scrollback | Cmd+F | Yes |
| Clear scrollback | Cmd+K | Yes |
| Jump to prev prompt | Cmd+Up | Yes |
| Jump to next prompt | Cmd+Down | Yes |
| History search | Ctrl+R | Yes |
| Quick terminal | Cmd+\` | Yes |
| Font size +/- | Cmd+=/- | Yes |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Command reference |
| `/theme` | Interactive theme picker |
| `/font` | Change terminal font |
| `/cursor` | Change cursor style |
| `/blocks` | Toggle command block rendering |
| `/history` | Search command history |
| `/shell-integration` | Toggle shell integration |
| `/terminfo` | Show TERM value and tmux/SSH tips |
| `/llm models` | Open model picker |
| `/agent` | Open agent pane |
| `/version` | Print version |

## Architecture

```
src/                          # TypeScript frontend
  main.ts                     # Entry point, keybinding dispatch
  tabs/                       # Tab bar, TabSession, drag reorder
  panes/                      # PaneLayout binary tree, dividers
  blocks/                     # Command block renderer, error assist
  config/                     # Keybinding system, command palette
  terminal/                   # DOMGrid, search, selection, mouse, zones
  visor/                      # Quick terminal dropdown
  session/                    # Session save/restore
  themes/                     # Theme manager, 6 themes
  llm/                        # LLM panel, onboarding, context
  agent/                      # Agent pane, tools, permissions

src-tauri/src/                # Rust backend
  lib.rs                      # Tauri commands, session map, I/O threads
  terminal.rs                 # VTE engine (alacritty_terminal), zones
  pty.rs                      # PTY management, shell integration injection
  osc.rs                      # OSC 7/133 byte scanner
  config.rs                   # TOML config, file watcher
  session_restore.rs          # Session persistence
  monitor.rs                  # System stats poller
  ollama.rs                   # Ollama client
  openai_compat.rs            # OpenAI-compatible provider

resources/
  shell-integration/          # Auto-injected zsh/bash/fish scripts
  default-config.toml         # Default configuration template
```

## License

MIT
