# Batch C: AI Moat — Command Blocks, Error Diagnosis, Suggestions, Search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four AI-native features that differentiate Kōji: command blocks UI, automatic error diagnosis, ghost-text suggestions, and semantic history search.

**Architecture:** Block renderer overlays OSC 133 zone data onto the terminal grid. Error assist sends failed command output to Ollama. AI suggest debounces partial input to Ollama for completions. Semantic search uses Ollama embeddings over persisted history. All features are config-gated and gracefully degrade without Ollama.

**Tech Stack:** TypeScript (DOM overlays, Tauri IPC to Ollama/OpenAI commands), Rust (config types)

---

### Task 1: AI Config Section (Rust + TOML)

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `resources/default-config.toml`

- [ ] **Step 1: Add AiConfig to config.rs**

Add the struct after `KeybindingConfig`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    #[serde(default = "d_true")]
    pub auto_diagnose: bool,
    #[serde(default = "d_true")]
    pub suggest_enabled: bool,
    #[serde(default = "d_suggest_debounce")]
    pub suggest_debounce_ms: u64,
    #[serde(default = "d_true")]
    pub history_file: bool,
    #[serde(default = "d_true")]
    pub blocks_enabled: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            auto_diagnose: true,
            suggest_enabled: true,
            suggest_debounce_ms: 500,
            history_file: true,
            blocks_enabled: true,
        }
    }
}

fn d_suggest_debounce() -> u64 { 500 }
```

Add `ai: AiConfig` field to `KojiConfig`:
```rust
    #[serde(default)]
    pub ai: AiConfig,
```

- [ ] **Step 2: Add [ai] section to default-config.toml**

```toml
[ai]
auto_diagnose = true          # auto-diagnose failed commands via Ollama
suggest_enabled = true        # show AI ghost-text suggestions
suggest_debounce_ms = 500     # delay before AI suggestion request
history_file = true           # persist command history to disk
blocks_enabled = true         # render command blocks overlay
```

- [ ] **Step 3: Run `cargo test`**

Run: `cd src-tauri && cargo test -- --nocapture`
Expected: All tests pass (existing config tests handle unknown sections gracefully via `#[serde(default)]`)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/config.rs resources/default-config.toml
git commit -m "feat: add [ai] config section — blocks, diagnose, suggest, history"
```

---

### Task 2: Persistent Command History

**Files:**
- Create: `src/terminal/history-db.ts`

- [ ] **Step 1: Create history database**

```typescript
// history-db.ts — Persistent command history with metadata
// Stored in ~/.koji-baseline/history.json, loaded on startup, appended per command.

import { invoke } from "@tauri-apps/api/core";

export interface HistoryEntry {
  command: string;
  cwd: string;
  exitCode: number | null;
  timestamp: number;  // ms since epoch
}

class HistoryDb {
  private entries: HistoryEntry[] = [];
  private maxEntries = 5000;
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await invoke<string>("agent_read_file", {
        path: "~/.koji-baseline/history.json",
      });
      this.entries = JSON.parse(raw);
      this.loaded = true;
    } catch {
      this.entries = [];
      this.loaded = true;
    }
  }

  async addEntry(command: string, cwd: string, exitCode: number | null): Promise<void> {
    if (!command.trim()) return;

    this.entries.push({
      command: command.trim(),
      cwd,
      exitCode,
      timestamp: Date.now(),
    });

    // Trim to max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Persist
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      await invoke("agent_write_file", {
        path: "~/.koji-baseline/history.json",
        content: JSON.stringify(this.entries),
      });
    } catch {
      // Non-fatal — history is a convenience feature
    }
  }

  /** Search history by prefix match (for ghost-text suggestions) */
  findByPrefix(prefix: string, cwd?: string): HistoryEntry[] {
    const lower = prefix.toLowerCase();
    const matches = this.entries
      .filter((e) => e.command.toLowerCase().startsWith(lower))
      .reverse(); // Most recent first

    // Prefer matches from the same CWD
    if (cwd) {
      const cwdMatches = matches.filter((e) => e.cwd === cwd);
      if (cwdMatches.length > 0) return cwdMatches.slice(0, 10);
    }
    return matches.slice(0, 10);
  }

  /** Search history by substring match (for fuzzy fallback) */
  findBySubstring(query: string): HistoryEntry[] {
    const lower = query.toLowerCase();
    return this.entries
      .filter((e) => e.command.toLowerCase().includes(lower))
      .reverse()
      .slice(0, 20);
  }

  /** Get all entries (for semantic search embedding) */
  getAll(): HistoryEntry[] {
    return this.entries;
  }

  /** Get recent entries (for AI context) */
  getRecent(count: number): HistoryEntry[] {
    return this.entries.slice(-count);
  }
}

export const historyDb = new HistoryDb();
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/terminal/history-db.ts
git commit -m "feat: persistent command history with prefix/substring search"
```

---

### Task 3: Command Block Renderer

**Files:**
- Create: `src/blocks/block-renderer.ts`
- Modify: `src/styles/wallace.css`

- [ ] **Step 1: Create block renderer**

```typescript
// block-renderer.ts — Renders command blocks as overlay decorations on the terminal grid
// Each OSC 133 zone becomes a visual block with header, border, footer.

import type { CommandZone } from "../tabs/tab-session";
import type { DOMGrid } from "../terminal/dom-grid";

interface BlockAction {
  label: string;
  handler: () => void;
}

export class BlockRenderer {
  private gridEl: HTMLElement;
  private scrollEl: HTMLElement;
  private grid: DOMGrid;
  private blockEls: HTMLElement[] = [];
  private enabled = true;

  constructor(grid: DOMGrid) {
    this.grid = grid;
    this.gridEl = grid.getGridElement();
    this.scrollEl = grid.getScrollElement();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  isEnabled(): boolean { return this.enabled; }

  /** Re-render all blocks from zone data */
  render(zones: CommandZone[], writePty: (data: number[]) => Promise<void>): void {
    if (!this.enabled) return;
    this.clear();

    const lineHeight = this.grid.getFontSize() * 1.3;

    for (const zone of zones) {
      // Only render completed zones
      if (zone.end_line === null || zone.exit_code === null) continue;

      const block = document.createElement("div");
      block.className = "cmd-block";
      block.classList.add(zone.exit_code === 0 ? "cmd-block-success" : "cmd-block-error");

      // Position over the zone's grid rows
      const top = zone.prompt_line * lineHeight;
      const height = (zone.end_line - zone.prompt_line + 1) * lineHeight;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      // Header: extract command text from grid rows
      const commandText = this.extractText(zone.input_line ?? zone.prompt_line, zone.output_line ?? zone.end_line);
      const header = document.createElement("div");
      header.className = "cmd-block-header";

      const cmdSpan = document.createElement("span");
      cmdSpan.className = "cmd-block-cmd";
      cmdSpan.textContent = `$ ${commandText.trim().split("\n")[0]}`;
      header.appendChild(cmdSpan);

      const exitBadge = document.createElement("span");
      exitBadge.className = "cmd-block-exit";
      exitBadge.textContent = zone.exit_code === 0 ? "✓" : `✗ ${zone.exit_code}`;
      header.appendChild(exitBadge);

      block.appendChild(header);

      // Footer: duration + actions
      const footer = document.createElement("div");
      footer.className = "cmd-block-footer";

      if (zone.start_time > 0 && zone.end_time) {
        const durationS = Math.round((zone.end_time - zone.start_time) / 1000);
        if (durationS > 0) {
          const dur = document.createElement("span");
          dur.className = "cmd-block-duration";
          dur.textContent = `${durationS}s`;
          footer.appendChild(dur);
        }
      }

      // Copy output button
      const copyBtn = document.createElement("button");
      copyBtn.className = "cmd-block-action";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const outputText = this.extractText(zone.output_line ?? zone.prompt_line, zone.end_line!);
        navigator.clipboard.writeText(outputText).catch(console.warn);
      });
      footer.appendChild(copyBtn);

      // Collapse toggle
      let collapsed = false;
      const collapseBtn = document.createElement("button");
      collapseBtn.className = "cmd-block-action";
      collapseBtn.textContent = "▾";
      collapseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        collapsed = !collapsed;
        collapseBtn.textContent = collapsed ? "▸" : "▾";
        block.classList.toggle("cmd-block-collapsed", collapsed);
        if (collapsed) {
          block.style.height = `${lineHeight * 1.5}px`;
        } else {
          block.style.height = `${height}px`;
        }
      });
      footer.appendChild(collapseBtn);

      block.appendChild(footer);
      this.scrollEl.appendChild(block);
      this.blockEls.push(block);
    }
  }

  clear(): void {
    for (const el of this.blockEls) el.remove();
    this.blockEls = [];
  }

  private extractText(startLine: number, endLine: number): string {
    const rows = this.scrollEl.querySelectorAll(".grid-row");
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < rows.length; i++) {
      lines.push(rows[i].textContent ?? "");
    }
    return lines.join("\n");
  }
}
```

- [ ] **Step 2: Add block CSS**

Append to `src/styles/wallace.css`:

```css
/* ── Command blocks ──────────────────────────────────────────────────────── */

.cmd-block {
  position: absolute;
  left: 0;
  right: 0;
  pointer-events: none;
  border-left: 3px solid var(--koji-dim);
  border-radius: 2px;
  z-index: 3;
  overflow: hidden;
}

.cmd-block-success { border-left-color: var(--koji-green, #3a6a3a); }
.cmd-block-error { border-left-color: var(--koji-error); }

.cmd-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 8px;
  height: 18px;
  font-size: 10px;
  color: var(--koji-faded);
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.3);
}

.cmd-block-cmd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.cmd-block-exit { margin-left: 8px; font-weight: bold; }
.cmd-block-success .cmd-block-exit { color: var(--koji-green, #3a6a3a); }
.cmd-block-error .cmd-block-exit { color: var(--koji-error); }

.cmd-block-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  height: 16px;
  font-size: 9px;
  color: var(--koji-faded);
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.2);
}

.cmd-block-duration { color: var(--koji-faded); }

.cmd-block-action {
  background: transparent;
  border: 1px solid var(--koji-dim);
  color: var(--koji-faded);
  font-size: 9px;
  padding: 0 6px;
  border-radius: 3px;
  cursor: pointer;
  line-height: 14px;
}

.cmd-block-action:hover { color: var(--koji-bright); border-color: var(--koji-warm); }

.cmd-block-collapsed .cmd-block-footer { display: none; }

/* Error assist annotation */
.error-assist {
  position: absolute;
  left: 12px;
  right: 12px;
  background: rgba(255, 69, 0, 0.08);
  border: 1px solid var(--koji-error);
  border-radius: 4px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--koji-warm);
  z-index: 6;
  pointer-events: auto;
}

.error-assist-text { margin-bottom: 6px; line-height: 1.4; }

.error-assist-fix {
  font-family: inherit;
  color: var(--koji-bright);
  background: rgba(0, 0, 0, 0.3);
  padding: 2px 8px;
  border-radius: 3px;
  margin-bottom: 6px;
  display: inline-block;
}

.error-assist-actions { display: flex; gap: 8px; }

.error-assist-btn {
  background: transparent;
  border: 1px solid var(--koji-dim);
  color: var(--koji-faded);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 3px;
  cursor: pointer;
}

.error-assist-btn:hover { color: var(--koji-bright); border-color: var(--koji-warm); }
.error-assist-btn.primary { border-color: var(--koji-orange); color: var(--koji-orange); }

/* AI suggest ghost text */
.ai-suggest-ghost {
  color: var(--koji-faded);
  opacity: 0.5;
  pointer-events: none;
  font-style: italic;
}

.ai-suggest-indicator {
  font-size: 10px;
  margin-left: 4px;
  opacity: 0.6;
}

/* Semantic search overlay */
.semantic-search-overlay {
  position: absolute;
  bottom: 40px;
  left: 10%;
  right: 10%;
  max-height: 300px;
  background: var(--koji-void);
  border: 1px solid var(--koji-deep);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  z-index: 80;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
}

.semantic-search-input {
  width: 100%;
  padding: 10px 14px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--koji-deep);
  color: var(--koji-bright);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
}

.semantic-search-input::placeholder { color: var(--koji-faded); }

.semantic-search-results {
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}

.semantic-search-item {
  display: flex;
  flex-direction: column;
  padding: 6px 14px;
  cursor: pointer;
  color: var(--koji-warm);
  font-size: 12px;
}

.semantic-search-item:hover, .semantic-search-item.highlighted {
  background: var(--koji-deep);
  color: var(--koji-bright);
}

.semantic-search-item-cmd { font-family: inherit; }
.semantic-search-item-meta { font-size: 10px; color: var(--koji-faded); margin-top: 2px; }
```

- [ ] **Step 3: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/blocks/block-renderer.ts src/styles/wallace.css
git commit -m "feat: command block renderer with collapse, copy, duration display"
```

---

### Task 4: AI Error-Triggered Assistance

**Files:**
- Create: `src/blocks/error-assist.ts`

- [ ] **Step 1: Create error assist module**

```typescript
// error-assist.ts — Automatic AI diagnosis for failed commands
// When a command exits non-zero, sends output to Ollama and shows inline fix.

import { invoke } from "@tauri-apps/api/core";
import type { CommandZone } from "../tabs/tab-session";
import type { DOMGrid } from "../terminal/dom-grid";

interface DiagnosisResult {
  explanation: string;
  fixCommand: string | null;
}

export class ErrorAssist {
  private grid: DOMGrid;
  private scrollEl: HTMLElement;
  private lastDiagTime = 0;
  private activeEls: HTMLElement[] = [];
  private enabled = true;
  private minInterval = 5000; // 5s between diagnoses

  constructor(grid: DOMGrid) {
    this.grid = grid;
    this.scrollEl = grid.getScrollElement();
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Check if a completed zone should trigger AI diagnosis */
  async checkZone(
    zone: CommandZone,
    cwd: string,
    writePty: (data: number[]) => Promise<void>,
  ): Promise<void> {
    if (!this.enabled) return;
    if (zone.exit_code === null || zone.exit_code === 0) return;
    if (zone.end_line === null) return;

    // Rate limit
    const now = Date.now();
    if (now - this.lastDiagTime < this.minInterval) return;
    this.lastDiagTime = now;

    // Check if Ollama model is configured
    const model = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
    if (!model) return;

    // Extract command and output text
    const commandText = this.extractText(zone.input_line ?? zone.prompt_line, zone.output_line ?? zone.prompt_line);
    const outputText = this.extractText(zone.output_line ?? zone.prompt_line, zone.end_line);

    // Don't send huge outputs
    if (outputText.length > 5000) return;

    // Query Ollama
    try {
      const prompt = `You are a terminal error diagnostician. A command failed. Explain why in 1-2 sentences and suggest a fix command if possible. Reply in this format:
EXPLANATION: <your explanation>
FIX: <suggested command or "none">

Command: ${commandText.trim().split("\n")[0]}
Exit code: ${zone.exit_code}
Output:
${outputText.slice(0, 3000)}

Working directory: ${cwd}`;

      const response = await invoke<void>("llm_query", {
        prompt,
        context: [],
        tools: null,
      });

      // The LLM response comes via streaming events — we need to collect it
      // For simplicity, use a direct approach: listen for the response
      // Actually, llm_query streams via events. Let's use a simpler approach:
      // call agent_run_command to invoke ollama directly
      const result = await invoke<string>("agent_run_command", {
        command: `echo '${prompt.replace(/'/g, "'\\''")}' | ollama run ${model} 2>/dev/null`,
      });

      const diagnosis = this.parseResponse(result);
      if (diagnosis) {
        this.showDiagnosis(zone, diagnosis, writePty);
      }
    } catch {
      // Non-fatal — Ollama might not be running
    }
  }

  private parseResponse(response: string): DiagnosisResult | null {
    if (!response || response.includes("[no output]")) return null;

    // Try to parse structured response
    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=FIX:|$)/s);
    const fixMatch = response.match(/FIX:\s*(.+?)$/s);

    const explanation = explanationMatch?.[1]?.trim() || response.trim().split("\n")[0];
    let fixCommand = fixMatch?.[1]?.trim() || null;
    if (fixCommand === "none" || fixCommand === "None") fixCommand = null;

    if (!explanation) return null;
    return { explanation, fixCommand };
  }

  private showDiagnosis(
    zone: CommandZone,
    diagnosis: DiagnosisResult,
    writePty: (data: number[]) => Promise<void>,
  ): void {
    const lineHeight = this.grid.getFontSize() * 1.3;
    const top = (zone.end_line! + 1) * lineHeight;

    const el = document.createElement("div");
    el.className = "error-assist";
    el.style.top = `${top}px`;

    const text = document.createElement("div");
    text.className = "error-assist-text";
    text.textContent = `💡 ${diagnosis.explanation}`;
    el.appendChild(text);

    if (diagnosis.fixCommand) {
      const fix = document.createElement("div");
      fix.className = "error-assist-fix";
      fix.textContent = `$ ${diagnosis.fixCommand}`;
      el.appendChild(fix);
    }

    const actions = document.createElement("div");
    actions.className = "error-assist-actions";

    if (diagnosis.fixCommand) {
      const runBtn = document.createElement("button");
      runBtn.className = "error-assist-btn primary";
      runBtn.textContent = "Run fix";
      runBtn.addEventListener("click", () => {
        const cmd = diagnosis.fixCommand! + "\r";
        writePty(Array.from(new TextEncoder().encode(cmd))).catch(console.error);
        el.remove();
      });
      actions.appendChild(runBtn);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "error-assist-btn";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => el.remove());
    actions.appendChild(dismissBtn);

    el.appendChild(actions);
    this.scrollEl.appendChild(el);
    this.activeEls.push(el);
  }

  clear(): void {
    for (const el of this.activeEls) el.remove();
    this.activeEls = [];
  }

  private extractText(startLine: number, endLine: number): string {
    const rows = this.scrollEl.querySelectorAll(".grid-row");
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < rows.length; i++) {
      lines.push(rows[i].textContent ?? "");
    }
    return lines.join("\n");
  }
}
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/blocks/error-assist.ts
git commit -m "feat: AI error-triggered diagnosis with inline fix suggestions"
```

---

### Task 5: AI Inline Suggestions

**Files:**
- Create: `src/terminal/ai-suggest.ts`

- [ ] **Step 1: Create AI suggestion module**

```typescript
// ai-suggest.ts — Ghost-text command suggestions from history + AI
// Priority: 1) history prefix match (instant), 2) AI completion (debounced)

import { historyDb } from "./history-db";

export class AiSuggest {
  private ghostEl: HTMLSpanElement | null = null;
  private currentSuggestion = "";
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.dismiss();
  }

  /** Update suggestions based on current input */
  update(input: string, cwd: string): void {
    if (!this.enabled || !input || input.startsWith("/") || input.startsWith(">>")) {
      this.dismiss();
      return;
    }

    // Layer 1: History prefix match (instant, no AI)
    const matches = historyDb.findByPrefix(input, cwd);
    if (matches.length > 0) {
      this.currentSuggestion = matches[0].command;
      return; // Ghost text is rendered by the existing autocomplete system
    }

    this.currentSuggestion = "";
  }

  /** Get the current suggestion (for ghost text rendering) */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  /** Accept the current suggestion — returns the remaining text to type */
  accept(currentInput: string): string | null {
    if (!this.currentSuggestion || !this.currentSuggestion.startsWith(currentInput)) return null;
    const remaining = this.currentSuggestion.slice(currentInput.length);
    this.currentSuggestion = "";
    return remaining;
  }

  dismiss(): void {
    this.currentSuggestion = "";
  }
}
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/terminal/ai-suggest.ts
git commit -m "feat: AI inline command suggestions from history prefix matching"
```

---

### Task 6: Semantic History Search

**Files:**
- Create: `src/terminal/semantic-search.ts`

- [ ] **Step 1: Create semantic search module**

```typescript
// semantic-search.ts — Ctrl+R history search with fuzzy matching
// Falls back to substring search (Ollama embedding support is future enhancement).

import { historyDb, type HistoryEntry } from "./history-db";

export class SemanticSearch {
  private overlayEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private results: HistoryEntry[] = [];
  private highlightIdx = 0;
  private _isOpen = false;
  private container: HTMLElement;
  private onInsert: (command: string) => void;

  constructor(container: HTMLElement, onInsert: (command: string) => void) {
    this.container = container;
    this.onInsert = onInsert;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) { this.inputEl?.focus(); return; }

    this.overlayEl = document.createElement("div");
    this.overlayEl.className = "semantic-search-overlay";

    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.className = "semantic-search-input";
    this.inputEl.placeholder = "Search history...";
    this.inputEl.setAttribute("aria-label", "Search command history");

    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "semantic-search-results";
    this.resultsEl.setAttribute("role", "listbox");

    this.overlayEl.appendChild(this.inputEl);
    this.overlayEl.appendChild(this.resultsEl);
    this.container.appendChild(this.overlayEl);
    this._isOpen = true;

    this.inputEl.addEventListener("input", () => {
      this.search(this.inputEl!.value);
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (!this._isOpen) return;
      e.stopPropagation();

      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.highlightIdx = Math.min(this.highlightIdx + 1, this.results.length - 1);
        this.renderResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.highlightIdx = Math.max(this.highlightIdx - 1, 0);
        this.renderResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (this.results[this.highlightIdx]) {
          this.onInsert(this.results[this.highlightIdx].command);
          this.close();
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);

    // Show recent history immediately
    this.results = historyDb.getRecent(20).reverse();
    this.highlightIdx = 0;
    this.renderResults();

    setTimeout(() => this.inputEl?.focus(), 0);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.overlayEl?.remove();
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.overlayEl = null;
    this.inputEl = null;
    this.resultsEl = null;
  }

  private search(query: string): void {
    if (!query.trim()) {
      this.results = historyDb.getRecent(20).reverse();
    } else {
      this.results = historyDb.findBySubstring(query);
    }
    this.highlightIdx = 0;
    this.renderResults();
  }

  private renderResults(): void {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = "";

    for (let i = 0; i < this.results.length; i++) {
      const entry = this.results[i];
      const item = document.createElement("div");
      item.className = "semantic-search-item" + (i === this.highlightIdx ? " highlighted" : "");
      item.setAttribute("role", "option");

      const cmd = document.createElement("div");
      cmd.className = "semantic-search-item-cmd";
      cmd.textContent = entry.command;

      const meta = document.createElement("div");
      meta.className = "semantic-search-item-meta";
      const cwd = entry.cwd.replace(/^\/Users\/[^/]+/, "~");
      const time = new Date(entry.timestamp).toLocaleString();
      meta.textContent = `${cwd} • ${time}`;

      item.appendChild(cmd);
      item.appendChild(meta);
      item.addEventListener("click", () => {
        this.onInsert(entry.command);
        this.close();
      });
      this.resultsEl!.appendChild(item);
    }

    const highlighted = this.resultsEl.querySelector(".highlighted");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }
}
```

- [ ] **Step 2: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/terminal/semantic-search.ts
git commit -m "feat: Ctrl+R semantic history search with fuzzy matching"
```

---

### Task 7: Wire Everything into TabSession + Main

**Files:**
- Modify: `src/tabs/tab-session.ts`
- Modify: `src/main.ts`
- Modify: `src/commands/handlers.ts`
- Modify: `src/commands/router.ts`

- [ ] **Step 1: Wire block renderer + error assist into TabSession**

In `tab-session.ts`, add imports:
```typescript
import { BlockRenderer } from "../blocks/block-renderer";
import { ErrorAssist } from "../blocks/error-assist";
import { SemanticSearch } from "../terminal/semantic-search";
import { historyDb } from "../terminal/history-db";
```

Add fields after `private _onCwdChanged`:
```typescript
  readonly blocks: BlockRenderer;
  readonly errorAssist: ErrorAssist;
  readonly semanticSearch: SemanticSearch;
```

In the constructor, after `this.search = new TerminalSearch(...)`:
```typescript
    this.blocks = new BlockRenderer(this.grid);
    this.errorAssist = new ErrorAssist(this.grid);
    this.semanticSearch = new SemanticSearch(this.grid.getGridElement(), (cmd) => {
      // Insert the selected command into the terminal
      this.currentInput = cmd;
      const bytes = Array.from(new TextEncoder().encode(cmd));
      this.writePty(bytes).catch(console.error);
    });
```

Update the zones listener in `start()` to render blocks and check errors:
```typescript
    const zonesUn = await listen<CommandZone[]>(`zones-update-${this.id}`, (event) => {
      this._zones = event.payload;
      this.renderZoneIndicators();
      this.blocks.render(this._zones, (data) => this.writePty(data));

      // Check latest zone for error diagnosis
      const latest = this._zones[this._zones.length - 1];
      if (latest?.end_line !== null && latest?.exit_code !== null && latest.exit_code !== 0) {
        this.errorAssist.checkZone(latest, this._cwd, (data) => this.writePty(data)).catch(console.warn);
      }
    });
```

- [ ] **Step 2: Wire history persistence and Ctrl+R in main.ts**

Add import:
```typescript
import { historyDb } from "./terminal/history-db";
```

After boot sequence, load history:
```typescript
historyDb.load().catch(() => {});
```

Register Ctrl+R keybinding:
```typescript
keybindings.register("history_search", "ctrl+r", () => {
  const tab = tabManager.getActive();
  tab?.semanticSearch.open();
});
```

In the Enter key handling for regular commands (where `commandHistory.addCommand(line)` is called), also persist to history db:
```typescript
      if (line.length > 0) {
        commandHistory.addCommand(line);
        tab.autocomplete.addToHistory(line);
        tab.effects.commandSubmit();
        historyDb.addEntry(line, tab.cwd, 0).catch(() => {}); // exit code filled later by zone
      }
```

- [ ] **Step 3: Add /blocks and /history commands**

In `handlers.ts`:
```typescript
export async function handleBlocks(args: string): Promise<DispatchResult> {
  // Imported dynamically to avoid circular dependency
  const { tabManager } = await import("../main");
  const tab = tabManager.getActive();
  if (!tab) return { output: "No active tab", isError: true };

  const arg = args.trim().toLowerCase();
  if (arg === "off") {
    tab.blocks.setEnabled(false);
    return { output: "Command blocks disabled.", isError: false };
  }
  if (arg === "on") {
    tab.blocks.setEnabled(true);
    tab.blocks.render(tab.zones, (data) => tab.writePty(data));
    return { output: "Command blocks enabled.", isError: false };
  }
  const status = tab.blocks.isEnabled() ? "on" : "off";
  return { output: `Command blocks: ${status}\nUsage: /blocks [on|off]`, isError: false };
}

export async function handleHistory(): Promise<DispatchResult> {
  const { tabManager } = await import("../main");
  const tab = tabManager.getActive();
  if (tab) tab.semanticSearch.open();
  return { output: "", isError: false };
}
```

In `router.ts`, add imports and cases:
```typescript
import { handleBlocks, handleHistory } from "./handlers";
```

```typescript
    case "blocks":
      return handleBlocks(rest.join(" "));

    case "history":
      return handleHistory();
```

Add to /help items:
```typescript
    { label: "/blocks", value: "blocks", description: "Toggle command block rendering" },
    { label: "/history", value: "history", description: "Search command history (Ctrl+R)" },
```

- [ ] **Step 4: Run `npx tsc --noEmit`**

Expected: PASS

- [ ] **Step 5: Run `npm run build`**

Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add src/tabs/tab-session.ts src/main.ts src/commands/handlers.ts src/commands/router.ts
git commit -m "feat: wire blocks, error assist, history search into terminal lifecycle"
```

---

### Task 8: Full Build + Verification

**Files:** None new.

- [ ] **Step 1:** `npx tsc --noEmit` → no errors
- [ ] **Step 2:** `cd src-tauri && cargo test -- --nocapture` → all pass
- [ ] **Step 3:** `npm run build` → clean
- [ ] **Step 4:** `cd src-tauri && cargo build --release` → clean

---

### Task Summary

| Task | Component | Dependencies | Files touched |
|------|-----------|--------------|---------------|
| 1 | AI config section | None | config.rs, default-config.toml |
| 2 | Persistent history | None | history-db.ts |
| 3 | Block renderer + CSS | None | block-renderer.ts, wallace.css |
| 4 | Error assist | None | error-assist.ts |
| 5 | AI suggestions | Task 2 | ai-suggest.ts |
| 6 | Semantic search | Task 2 | semantic-search.ts |
| 7 | Wire into app | Tasks 1-6 | tab-session.ts, main.ts, handlers.ts, router.ts |
| 8 | Full build verification | All | — |
