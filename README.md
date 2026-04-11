# Koji Baseline

**A cyberpunk terminal emulator for macOS with native AI integration.**

Free. Open source. Solo-built. No telemetry. No account required.

---

## Why Koji?

I started building Koji because I spent more time fighting my terminal than using it. I'd recently switched to living in the command line full-time — running Claude Code, managing containers, SSH sessions, long builds — and the existing options all had the same problem: they were either fast but featureless, or feature-rich but slow and bloated.

iTerm2 felt sluggish. Warp wanted my email and sent my terminal output to the cloud. Ghostty was fast but too minimal. Kitty had great features behind arcane config. And none of them had AI that actually understood what I was doing.

So I built the terminal I wanted:

- **AI that lives locally.** Ollama runs on your machine. Your commands, your output, your context — none of it leaves your computer. Failed command? Koji diagnoses it automatically and suggests a fix. No cloud API. No subscription.

- **Terminal features that just work.** Split panes, session restore, configurable keybindings, command palette, shell integration — all the things power users expect. Edit a TOML file, save, done. No restart needed.

- **A look that doesn't apologize.** Six cyberpunk themes, boot sequence animation, kanji idle animator. This is a tool with personality. Every pixel is intentional.

- **Built for the AI age.** Command blocks group your output like Warp, but locally. Ghost-text suggestions from your history. Semantic search that finds "that docker command from yesterday." An agent pane with full tool use. This isn't AI bolted onto a terminal — the terminal was designed around AI from day one.

If you're a developer who lives in the terminal and wants AI assistance without giving up privacy or performance, Koji is for you.

---

## Features

### Terminal Core
- **Split panes** — Cmd+D (right), Cmd+Shift+D (down), draggable dividers, pane zoom (Cmd+Shift+Enter)
- **Shell integration** — OSC 7 (CWD tracking), OSC 133 (semantic zones), auto-injected for zsh/bash/fish
- **Command blocks** — each command + output grouped as a collapsible, copyable block with duration display
- **Multi-tab** — Cmd+T/W, drag to reorder, pane count badges, CWD-based tab names
- **Session restore** — tabs and CWDs persist across app restarts
- **Quick terminal** — Cmd+\` visor drops down from the top of the screen
- **Full VT100/ANSI** — truecolor, 256-color, alt screen, mouse reporting (SGR), bracketed paste
- **Scrollback search** — Cmd+F with match navigation
- **Clickable URLs and file paths** — hover underline, click to open
- **OSC 52 clipboard** — copy/paste works over SSH
- **Synchronized rendering** — DCS mode 2026 prevents tearing during heavy output
- **Secure keyboard entry** — macOS Carbon API prevents keystroke interception

### AI Integration (all local, all private)
- **Auto error diagnosis** — failed commands analyzed by Ollama with inline fix suggestions and one-click execution
- **Inline suggestions** — ghost-text completions from your command history
- **Semantic history search** — Ctrl+R finds commands by meaning, not just text
- **Agent pane** — full tool-use agent: file read/write/edit, shell commands, web fetch, directory search
- **Inline LLM queries** — type `>> your question` for instant answers in the terminal
- **Multi-provider** — Ollama (default) + any OpenAI-compatible API (Together, Groq, Fireworks)

### Configuration
- **TOML config** — `~/.koji-baseline/config.toml`, hot reloads on save
- **Configurable keybindings** — remap every shortcut, `cmd+shift+p` format
- **Command palette** — Cmd+Shift+P, fuzzy-filtered action list
- **6 cyberpunk themes** — Wallace, Neon, Void, Ember, Frost, Sakura
- **4 bundled monospace fonts** — JetBrains Mono, Fira Code, Cascadia Code, Iosevka (with ligature toggle)
- **Cursor styles** — block, beam, underline
- **Process notifications** — macOS notification when long-running commands finish in the background

---

## Install

### From DMG

Download the latest `.dmg` from [Releases](https://github.com/hanamori/koji-baseline/releases), open it, drag Koji Baseline to Applications.

### From Source

Requires: Node.js 18+, Rust 1.75+, macOS 14+ (Sonoma or later)

```bash
git clone https://github.com/hanamori/koji-baseline.git
cd koji-baseline
npm install
npx tauri build
```

The app bundle lands at `src-tauri/target/release/bundle/macos/Koji Baseline.app`.

### AI Setup (optional)

Koji works as a standalone terminal without AI. To enable AI features:

1. Install [Ollama](https://ollama.com)
2. Pull a model: `ollama pull llama3.2`
3. Click the `>>` badge in Koji's status bar to configure

---

## Keyboard Shortcuts

All shortcuts are configurable in `~/.koji-baseline/config.toml`.

| Action | Default |
|--------|---------|
| New tab | Cmd+T |
| Close tab | Cmd+W |
| Close pane | Cmd+Shift+W |
| Split right | Cmd+D |
| Split down | Cmd+Shift+D |
| Navigate panes | Cmd+Option+Arrow |
| Zoom pane | Cmd+Shift+Enter |
| Command palette | Cmd+Shift+P |
| Search scrollback | Cmd+F |
| Clear scrollback | Cmd+K |
| Previous prompt | Cmd+Up |
| Next prompt | Cmd+Down |
| History search | Ctrl+R |
| Quick terminal | Cmd+\` |
| Font size +/- | Cmd+=/- |
| Copy / SIGINT | Cmd+C |
| Paste | Cmd+V |
| Select all | Cmd+A |

## Slash Commands

Type in the terminal and press Enter:

| Command | What it does |
|---------|-------------|
| `/help` | Command reference |
| `/theme` | Interactive theme picker |
| `/font` | Change terminal font |
| `/cursor` | Change cursor style (block/beam/underline) |
| `/blocks` | Toggle command block rendering on/off |
| `/history` | Open semantic history search |
| `/shell-integration` | Toggle shell integration on/off |
| `/terminfo` | Show TERM value and tmux/SSH tips |
| `/llm models` | Open model picker |
| `/llm recommend` | Show recommended Ollama models |
| `/agent` | Open the AI agent pane |
| `/exit` | Close the agent pane |
| `/version` | Print version |
| `>> question` | Ask the AI anything inline |

---

## Configuration

First launch creates `~/.koji-baseline/config.toml`:

```toml
[terminal]
theme = "wallace"
font = "JetBrains Mono"
font_size = 14
cursor_style = "block"
shell_integration = true
option_as_meta = true

[notifications]
enabled = true
min_duration_seconds = 10

[ai]
auto_diagnose = true
suggest_enabled = true
blocks_enabled = true

[keybindings]
new_tab = "cmd+t"
split_right = "cmd+d"
palette = "cmd+shift+p"
# ... full list in resources/default-config.toml

[quick_terminal]
enabled = true
hotkey = "cmd+`"
height_percent = 40
```

Edit the file, save — changes apply immediately. No restart needed.

---

## Development

```bash
npm run dev          # Vite dev server + Tauri hot reload
npm run build        # Frontend only
npx tauri build      # Full production build (.app + .dmg)
```

Tests:

```bash
cd src-tauri && cargo test    # 30 Rust tests (osc, terminal, config, session)
npx tsc --noEmit              # TypeScript type check
```

## Architecture

```
src/                          TypeScript frontend
  main.ts                     Entry point, keybinding dispatch
  tabs/                       Tab bar, TabSession, drag reorder
  panes/                      PaneLayout binary tree, dividers
  blocks/                     Command block renderer, error assist
  config/                     Keybinding system, command palette
  terminal/                   DOMGrid, search, selection, mouse, zones
  visor/                      Quick terminal dropdown
  session/                    Session save/restore
  themes/                     Theme manager, 6 themes
  llm/                        LLM panel, onboarding, context
  agent/                      Agent pane, tools, permissions

src-tauri/src/                Rust backend
  lib.rs                      Tauri commands, session map, I/O threads
  terminal.rs                 VTE engine (alacritty_terminal), zones
  pty.rs                      PTY management, shell integration injection
  osc.rs                      OSC 7/133 byte scanner
  config.rs                   TOML config, file watcher
  session_restore.rs          Session persistence
  monitor.rs                  System stats poller
  ollama.rs                   Ollama streaming client
  openai_compat.rs            OpenAI-compatible provider

resources/
  shell-integration/          Auto-injected zsh/bash/fish scripts
  default-config.toml         Default configuration template
```

---

## About

Koji Baseline is a solo project by [Hana Mori](https://github.com/hanamori). Built because every terminal I tried was missing something — and I figured if I'm going to live in the terminal, it should feel like home.

The name comes from the Japanese fermentation starter used to make miso, sake, and soy sauce. Koji transforms raw ingredients into something richer. That's the idea — take raw terminal I/O and transform it into something you actually enjoy using.

Free and open source under the MIT license. No tracking, no analytics, no accounts, no cloud dependencies. Just a terminal.

---

## License

[MIT](LICENSE) -- do whatever you want with it.
