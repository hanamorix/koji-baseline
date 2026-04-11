# Kōji Baseline v0.7 — Full Audit & Polish

## Goal

Systematic audit of the entire Kōji codebase for dead code, security, performance, usability, stability, and compatibility. Remove bloat, fix gaps, harden the app for daily-driver use.

## Audit Categories

### 1. Dead Code & Bloat Removal

**What to check:**
- Unused imports across all TypeScript files
- Unused exports (exported but never imported elsewhere)
- Orphaned files — code that exists but isn't wired into the app (e.g. the old `clickable.ts` functions that were replaced by `applyClickableRegions`)
- CSS rules that target classes no longer used in the DOM
- Rust functions not registered as Tauri commands and not called internally
- Unused dependencies in `Cargo.toml` and `package.json`
- Dead feature flags or config keys that nothing reads
- Comments referencing old task numbers or removed features (e.g. "Task 12", "Canvas")

**Goal:** Every file, function, import, and CSS rule earns its place or gets removed.

### 2. Security

**What to check:**
- **PTY environment inheritance**: Currently inherits full user env. Check for sensitive vars that shouldn't leak (AWS keys, tokens). Consider a whitelist approach instead of inheriting everything.
- **Clipboard access (OSC 52)**: Currently not implemented, but if added — write-only, never read. Verify.
- **Shell command execution**: `agent_run_command` runs arbitrary commands via `/bin/sh -c`. Verify it's only callable from the agent UI, not from arbitrary IPC.
- **File system access**: `agent_read_file`, `agent_write_file`, `agent_edit_file` — verify they can't escape the intended directory scope.
- **URL opening**: `open_url` calls system `open` — verify no command injection via crafted URLs.
- **Path expansion**: `expand_tilde` and path handling — check for path traversal.
- **Content Security Policy**: Check Tauri's CSP config for the webview.
- **Dependencies**: Run `cargo audit` and `npm audit` for known vulnerabilities.
- **Tauri permissions**: Review `tauri.conf.json` capabilities — principle of least privilege.

**Goal:** No command injection, no path traversal, no credential leakage, minimal attack surface.

### 3. Performance

**What to check:**
- **DOM grid render time**: Profile `renderImmediate()` with large viewports (200+ cols, 50+ rows). Is row-level diffing efficient enough?
- **Heavy output**: `cat /usr/share/dict/words` — measure frame drops, memory growth, scrollback DOM node count.
- **Scrollback memory**: With 10k scrollback lines, how much memory do the DOM nodes consume? Profile with DevTools.
- **Event listener leaks**: Check for listeners added but never removed (especially in clickable.ts per-cell handlers).
- **Font measurement**: `measureGrid()` creates and removes a DOM element — is this called too frequently during resize?
- **Autocomplete path queries**: Verify debouncing works, no concurrent requests stacking up.
- **Search performance**: Searching 10k scrollback lines — is it fast enough? Consider caching textContent.
- **Startup time**: Profile boot sequence to first interactive prompt. Target: under 2 seconds.
- **Bundle size**: Check the production JS/CSS bundle sizes and font file sizes. Iosevka is 1.3MB — consider subsetting.

**Goal:** Smooth 60fps rendering, sub-2s startup, under 150MB memory at steady state with 10k scrollback.

### 4. Usability

**What to check:**
- **Keyboard shortcut conflicts**: Map all Cmd+ shortcuts — any conflicts with macOS system shortcuts? Any conflicts between features (e.g. Cmd+C doing two things)?
- **Command discoverability**: Can a new user find all available commands? Is `/help` comprehensive?
- **Error messages**: Are error states clear? What happens when Ollama isn't running? When a font fails to load? When a path doesn't exist?
- **Config defaults**: Are defaults sensible for a first-time user? Block cursor, JetBrains Mono, Wallace theme, copy-on-select on.
- **Visual feedback**: Every action should have visible feedback. Command submit flash, theme switch, font change, cursor style change, bell.
- **Accessibility**: Minimum contrast ratios for text. Keyboard navigability. Screen reader considerations (ARIA labels on interactive elements).
- **Onboarding**: First launch experience — does the boot sequence + dashboard communicate what the app can do?

**Goal:** A new user can be productive in 5 minutes without reading docs.

### 5. Stability

**What to check:**
- **PTY crash handling**: What happens if the shell exits? If the PTY handle becomes invalid? Is there a reconnect or error state?
- **Resize edge cases**: Rapid resize events. Resize during heavy output. Resize while in alt screen.
- **Theme switch during operation**: Switch theme while LLM is streaming, while agent is running, while search is open.
- **Tab operations under stress**: (v0.6) Create 20 tabs rapidly. Close tabs while they're running long commands.
- **Memory leaks over time**: Run for 1 hour with moderate use. Monitor memory growth.
- **Error boundaries**: What happens if a Tauri invoke fails? If an event listener throws? Are errors logged but non-fatal?
- **Large clipboard paste**: Paste 100KB of text — does bracketed paste handle it? Does the PTY buffer overflow?
- **Unicode edge cases**: Combining characters, zero-width joiners, RTL text, emoji sequences (👨‍👩‍👧‍👦).

**Goal:** Zero crashes in 8 hours of normal use. Graceful degradation on errors.

### 6. Compatibility

**What to check:**
- **Shell compatibility**: zsh, bash, fish, nushell — test each as login shell.
- **TERM value**: `xterm-256color` — verify terminfo entries support all features we emit.
- **CLI tools**: Test these explicitly: `vim`, `nvim`, `htop`, `top`, `tmux`, `less`, `man`, `ssh`, `git log`, `docker`, `kubectl`, `claude` (Claude Code CLI), `python`, `node`, `cargo`, `npm`.
- **ANSI compliance**: Run `vttest` (VT100/VT220 test suite) if available.
- **Color rendering**: Run a truecolor test script — verify smooth gradient rendering.
- **macOS versions**: Test on macOS 14 (Sonoma) and 15 (Sequoia) at minimum.
- **Display scaling**: Retina (2x) and non-Retina displays. External monitors.

**Goal:** Every tool a developer uses daily works correctly in Kōji.

### 7. Polish

**What to check:**
- **Visual consistency**: All UI elements (dashboard, tab bar, overlay, menus, search, agent pane) use theme CSS variables — no hardcoded colors.
- **Animation smoothness**: All CSS animations feel smooth, not jerky. Consistent timing.
- **Font rendering**: Ligatures render correctly across all four bundled fonts. CJK and emoji display without misalignment.
- **Cursor consistency**: Cursor blink rate and style consistent across all three modes.
- **Spacing and alignment**: Consistent padding, margins, and gaps throughout the UI. Grid cells aligned perfectly.
- **Edge cases in UI**: Very long filenames in clickable URLs. Very long theme/font/cursor names in pickers. Empty states (no scrollback, no history, no suggestions).
- **Window management**: Minimum window size that doesn't break layout. Maximize behavior.
- **Icon and title**: App icon, window title, dock appearance.

**Goal:** Every pixel is intentional. The app feels handcrafted, not generated.

## Process

The audit runs as a series of focused passes:

1. **Automated scan** — `cargo audit`, `npm audit`, `tsc --noEmit`, grep for dead imports, unused CSS, orphaned files.
2. **Manual code review** — Read every file end-to-end. Flag issues by category.
3. **Testing pass** — Run each compatibility tool. Profile performance. Stress test stability.
4. **Fix pass** — Address all findings. Group into commits by category.
5. **Final verification** — Re-run automated scan. Confirm all issues resolved.

## Files Changed

This audit will touch most files in the codebase. Changes are primarily:
- Deletions (dead code, unused imports/exports)
- Security hardening (env var filtering, CSP tightening)
- Performance optimizations (event listener cleanup, DOM recycling)
- CSS cleanup (unused rules, hardcoded colors → variables)
- Error handling improvements (graceful failures, user-facing messages)

No new features — only improvements to existing code.
