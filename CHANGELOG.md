# Changelog

## v0.7.3 — 2026-04-14

### Fixes

- Terminal now renders correctly even when a solo pane has no assigned height (was showing 1 row / blank viewport).
- Scrollback no longer gets lost during large output bursts (e.g. launching Claude Code, `cat` on big files).
- DMG is ad-hoc signed so Gatekeeper stops marking it as "damaged" after download.


All notable changes to Koji Baseline.

## [0.7.0] — 2026-04-11

The "everything" release. Shell integration, split panes, AI features, configurable everything.

### Added — Shell Integration (Phase 1)
- OSC 7 working directory tracking — tabs show CWD, new tabs inherit it
- OSC 133 semantic zones — prompt/input/output/command-end markers
- Auto-injected shell scripts for zsh, bash, and fish (disable via config)
- KojiEventListener replaces VoidListener — captures Title, Clipboard, Bell events from alacritty_terminal
- OSC 52 clipboard support — copy/paste works over SSH
- Synchronized rendering (DCS mode 2026) — prevents tearing during heavy output
- Cmd+Up/Down zone navigation between command prompts
- Failed command zones marked with red left-border indicator
- `/shell-integration` slash command to toggle on/off

### Added — Config Infrastructure (Batch A)
- TOML config file at `~/.koji-baseline/config.toml` with hot reload on save
- Automatic migration from JSON config on first launch
- Configurable keybindings — remap every shortcut via config
- Command palette (Cmd+Shift+P) with fuzzy-filtered action list
- Long-running command notifications via macOS Notification API
- `/terminfo` command with tmux and SSH configuration tips
- Refactored main.ts from ~100 lines of hardcoded shortcuts to keybinding dispatch system

### Added — Split Panes (Batch B)
- PaneLayout binary tree — split any pane horizontally or vertically
- Cmd+D split right, Cmd+Shift+D split down
- Cmd+Option+Arrow pane navigation
- Cmd+Shift+Enter pane zoom toggle (maximize/restore)
- Cmd+Shift+W close active pane
- Draggable dividers between panes (double-click resets to 50/50)
- Focus dimming — inactive panes at 0.6 opacity, active pane gets orange left border
- Tab drag reorder — drag tabs to rearrange in tab bar
- Proxy icon — CWD path display in tab bar
- Pane count badge on tabs with splits

### Added — AI Features (Batch C)
- Command blocks UI — each command + output as a collapsible, copyable block with duration display
- AI error-triggered diagnosis — failed commands auto-analyzed by Ollama with inline fix suggestions
- "Run fix" button executes suggested commands with one click
- AI inline suggestions — ghost-text completions from command history prefix matching
- Semantic history search (Ctrl+R) — fuzzy search over persisted command history
- Persistent command history — saved to `~/.koji-baseline/history.json` with CWD and timestamps
- `/blocks` command to toggle block rendering on/off
- `/history` command to open history search
- `[ai]` config section for all AI feature toggles

### Added — Polish (Batch D)
- Session restore — tabs and CWDs saved on close, restored on launch
- Quick terminal visor — Cmd+\` drops a terminal from the top of the screen
- Secure keyboard entry — macOS Carbon FFI prevents keystroke interception, ASCII toggle `[○]`/`[●]`
- Session restore backend with single-use restore (prevents stale state)

### Changed
- Version bumped to 0.7.0 across package.json, Cargo.toml, tauri.conf.json
- All slash commands now appear in autocomplete suggestions
- Rust warning on unused Session.events field suppressed

## [0.6.0] — 2026-04-11

Terminal tabs with per-tab PTY sessions.

### Added
- Multi-tab terminal — Cmd+T new tab, Cmd+W close, Cmd+1-9 switch
- TabManager with tab bar UI, rename (double-click), close button
- Per-tab PTY sessions with scoped events (no crosstalk)
- "LINKED" animation on new tab creation
- Tab close switches to nearest neighbor
- Session-closed detection with `[exited]` state and dimmed tab

### Fixed
- Tab creation error recovery — renderTabBar before await, try/catch cleanup
- activate() no longer calls resize_session on unstarted sessions
- writePty() and resize() guard against dead sessions
- 256KB paste safety limit
- PTY env filtering — strips AWS_SECRET, API keys, tokens before shell spawn
- Clickable event delegation — 3 handlers instead of N-per-cell
- ARIA accessibility labels on all interactive elements
- Theme-aware LLM badge colors (centralized badge.ts)
- Tab rename protection flag
- Login+interactive shell spawn for proper PATH sourcing

## [0.5.0] — 2026-04-11

Terminal completeness — alt screen, meta key, mouse, search.

### Added
- Alt screen support for vim, htop, tmux
- Option-as-Meta key (sends ESC prefix)
- SGR mouse reporting for TUI applications
- Cmd+F scrollback search with match navigation
- Cmd+K clear scrollback
- Configurable cursor styles — block, beam, underline
- OSC title and terminal bell (visual flash)
- Complete ANSI attributes — strikethrough, hidden, blink

## [0.4.0] — 2026-04-11

Terminal quality pivot — DOM renderer, fonts, clipboard.

### Added
- DOM grid renderer with row-level diffing (replaced Canvas)
- 4 bundled fonts — JetBrains Mono, Fira Code, Cascadia Code, Iosevka
- Font size controls (Cmd+Plus/Minus/0)
- Ligature toggle
- Smart Cmd+C — copy selection or send SIGINT
- Copy-on-select with middle-click paste
- Bracketed paste support
- Scrollback buffer (10K lines, keyboard navigation)
- CSS-based cursor blink and transition effects

### Removed
- Canvas-based terminal renderer
- Waveform animation (viewport now expands to fill space)

## [0.3.0] — 2026-04-11

Agent system with multi-provider LLM support.

### Added
- Agent split-pane UI with conversation history
- 11 agent tools — file read/write/edit, shell commands, directory listing, search, web fetch
- Tool approval system (off/safe/full auto-run modes)
- OpenAI-compatible provider support (Together.ai, Groq, Fireworks)
- Interactive menu component with arrow keys and filtering
- LLM onboarding flow via >> badge
- DOM overlay system replacing Canvas-painted output

## [0.2.0] — 2026-04-11

Themes, slash commands, clickable paths.

### Added
- 6 cyberpunk themes — Wallace, Tyrell, Baseline, Netrunner, Arasaka, Militech
- Theme manager with runtime switching and persistence
- Slash command system — /help, /theme, /llm, /version
- Clickable URLs and file paths with hover underline

## [0.1.0] — 2026-04-11

Initial release. Live terminal with Ollama integration.

### Added
- PTY manager — spawn shell, handle I/O
- Terminal engine wrapping alacritty_terminal
- Ollama streaming chat with context-aware queries
- Wallace amber theme and dashboard layout
- ASCII boot sequence with holographic flicker
- Idle kanji cycling animation
- CWD and git status tracking
- Dynamic window resize
- Clipboard paste support
