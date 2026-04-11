# Koji Baseline Batch C — AI Moat: Command Blocks, Error Diagnosis, Inline Suggestions, Semantic Search

## Goal

Transform Kōji from "terminal with AI sidebar" into "AI-native terminal." Command output becomes structured blocks. Failed commands get automatic diagnosis. The command line gets ghost-text suggestions. History search understands meaning, not just text.

## Scope

4 features, ordered by dependency:

1. **Command Blocks UI** — group each command+output into a discrete, collapsible, copyable block using OSC 133 zone data
2. **AI Error-Triggered Assistance** — when a command fails (exit code != 0), automatically send output to Ollama for diagnosis and show inline fix suggestion
3. **AI Inline Command Suggestions** — ghost-text completions from history + optional AI enhancement
4. **Semantic History Search** — natural language search over command history using Ollama embeddings

## Non-Goals

- Full agentic development workflows (Warp Dispatch-style)
- Voice input
- Collaborative terminal sharing
- Replacing the existing agent pane (these features complement it)

---

## Architecture

### 1. Command Blocks UI (`src/blocks/block-renderer.ts`)

Command blocks render ON TOP of the existing terminal grid as a visual overlay. The raw terminal output stays in the DOMGrid — blocks are a rendering layer that groups and decorates it.

**Why overlay, not replace:** The terminal grid is the source of truth for VT100 rendering. Blocks are a UX enhancement that shows structure. Users can toggle blocks off and see raw output. This avoids reimplementing terminal rendering.

**Block structure:**
```
┌──────────────────────────────────────────┐
│ $ git status                        [0] ✓│  ← header: command + exit code
├──────────────────────────────────────────┤
│ On branch main                           │  ← output (from grid rows)
│ Changes not staged for commit:           │
│   modified: src/main.ts                  │
│                                          │
├──────────────────────────────────────────┤
│ ⏱ 0.3s  │  📋 Copy  │  ▾ Collapse      │  ← footer: duration + actions
└──────────────────────────────────────────┘
```

**Data source:** OSC 133 zones from `TabSession._zones`. Each completed zone (has `end_line` and `exit_code`) becomes a block. The block overlay reads zone data and positions decorations over the corresponding grid rows.

**Rendering approach:**
- Blocks are absolutely-positioned `<div>` elements inside the scroll container
- Each block wraps the grid rows from `prompt_line` to `end_line`
- Left border: green (exit 0) or red (non-zero)
- Header shows the command text (extracted from grid rows between `input_line` and `output_line`)
- Footer shows duration and action buttons
- Collapsed blocks hide output rows (just show header)

**Toggle:** `/blocks` slash command toggles block rendering on/off. Default: on.

### 2. AI Error-Triggered Assistance (`src/blocks/error-assist.ts`)

When a command block completes with exit code != 0:
1. Extract the command text and output text from the block's grid rows
2. Send to Ollama with a system prompt optimized for error diagnosis
3. Render the AI response as a collapsible annotation below the block
4. Include a "Run fix" button if the AI suggests a command

**AI prompt template:**
```
You are a terminal error diagnostician. A command failed. Explain why in 1-2 sentences and suggest a fix command if possible.

Command: {command}
Exit code: {exit_code}
Output:
{output}

Working directory: {cwd}
```

**Rate limiting:** Only auto-diagnose if:
- An Ollama model is configured (activeModel exists)
- The output is < 5000 chars (don't send huge outputs)
- No more than 1 diagnosis per 5 seconds (prevent spam)
- Config `ai.auto_diagnose = true` (default true, can disable)

**UI:** The diagnosis appears as an expandable annotation attached to the block:
```
┌──────────────────────────────────────────┐
│ $ npm run build                     [1] ✗│
├──────────────────────────────────────────┤
│ Error: Cannot find module 'foo'          │
├──────────────────────────────────────────┤
│ 💡 Missing dependency 'foo'.             │
│    Run: npm install foo                  │
│    [Run fix]  [Dismiss]                  │
└──────────────────────────────────────────┘
```

### 3. AI Inline Command Suggestions (`src/terminal/ai-suggest.ts`)

Ghost-text completions that appear as gray text after the cursor, accepted with Right Arrow.

**Three layers (in priority order):**

1. **History completion** (no AI, instant): Match the current input prefix against command history for this CWD. Show the most recent matching command as ghost text. This is the primary suggestion source — works offline, zero latency.

2. **AI suggestion** (optional, 500ms debounce): If the user pauses typing for 500ms and no history match was found, send the partial command + CWD + recent output context to Ollama for a completion suggestion. Show as ghost text with a subtle "✨" indicator.

3. **Natural language mode**: If the user types `?` as the first character (e.g., `?find large files`), intercept on Enter, send to Ollama for command generation, show the result as editable ghost text.

**Integration with existing autocomplete:** The existing `Autocomplete` class in `src/terminal/autocomplete.ts` handles path/command completions. AI suggestions are a separate layer that shows ghost text AFTER the autocomplete ghost text (or instead of, if autocomplete has nothing).

**Implementation:**
```typescript
class AiSuggest {
  private lastInput = "";
  private debounceTimer: number | null = null;
  private ghostEl: HTMLSpanElement | null = null;
  
  update(input: string, cwd: string, history: string[]): void
  accept(): string | null  // returns the full suggested command
  dismiss(): void
}
```

The ghost text is rendered as a span positioned after the cursor in the grid.

### 4. Semantic History Search (`src/terminal/semantic-search.ts`)

A search mode activated by Ctrl+R (or `/history` command) that accepts natural language queries.

**How it works:**
1. User presses Ctrl+R → search overlay opens (similar to Cmd+F but different UI)
2. User types a query: "that docker command from yesterday"
3. The query + all history entries are sent to Ollama's embedding endpoint
4. Nearest-neighbor search returns the best matches
5. Results shown in a scrollable list, Enter inserts the selected command

**Fallback:** If Ollama is not available or has no embedding model, fall back to fuzzy text matching (like standard Ctrl+R).

**History storage:** Commands are already stored via `commandHistory.addCommand()` in `src/llm/context.ts`. We need to persist them to disk with metadata (timestamp, CWD, exit code) for richer search.

**Implementation:**
```typescript
class SemanticSearch {
  private historyDb: CommandHistoryEntry[]
  
  open(): void           // show search UI
  close(): void
  search(query: string): Promise<CommandHistoryEntry[]>
  
  // Persist history to ~/.koji-baseline/history.json
  addEntry(command: string, cwd: string, exitCode: number): void
  loadHistory(): void
}
```

**Config:**
```toml
[ai]
auto_diagnose = true        # auto-diagnose failed commands
suggest_enabled = true       # show AI ghost-text suggestions
suggest_debounce_ms = 500   # delay before AI suggestion
history_file = true          # persist command history to disk
```

---

## File Changes (execution order)

| Order | File | Change | Est. lines |
|-------|------|--------|-----------|
| 1 | `src-tauri/src/config.rs` | Add `[ai]` config section | ~30 |
| 2 | `resources/default-config.toml` | Add `[ai]` defaults | ~10 |
| 3 | `src/blocks/block-renderer.ts` (NEW) | Command block overlay rendering | ~200 |
| 4 | `src/blocks/error-assist.ts` (NEW) | AI error diagnosis + inline fix | ~120 |
| 5 | `src/terminal/ai-suggest.ts` (NEW) | Ghost-text AI suggestions | ~130 |
| 6 | `src/terminal/semantic-search.ts` (NEW) | Ctrl+R semantic history search | ~150 |
| 7 | `src/terminal/history-db.ts` (NEW) | Persistent command history with metadata | ~80 |
| 8 | `src/tabs/tab-session.ts` | Wire block renderer + error assist on zone updates | ~20 |
| 9 | `src/main.ts` | Wire AI suggest, Ctrl+R, /blocks, /history commands | ~25 |
| 10 | `src/commands/handlers.ts` | Add /blocks, /history commands | ~20 |
| 11 | `src/commands/router.ts` | Wire new commands | ~5 |
| 12 | `src/styles/wallace.css` | Block, error-assist, suggest, search styles | ~80 |

**Estimated total: ~870 lines new/changed**

---

## Testing Strategy

### Manual Test Checklist

Command Blocks:
- [ ] After running 3 commands, blocks appear with left-border colors (green/red)
- [ ] Block header shows the command text
- [ ] Block footer shows duration
- [ ] Click "Copy" copies command output to clipboard
- [ ] Click "Collapse" hides output rows, click again expands
- [ ] `/blocks off` disables block rendering, `/blocks on` re-enables
- [ ] Blocks update correctly when scrollback grows
- [ ] Blocks work with split panes (each pane has its own blocks)

Error Diagnosis:
- [ ] Run a failing command (e.g., `npm run nonexistent`) → AI diagnosis appears below block
- [ ] Diagnosis shows explanation + suggested fix command
- [ ] "Run fix" button executes the suggested command
- [ ] "Dismiss" removes the diagnosis
- [ ] No diagnosis when Ollama is not running
- [ ] No diagnosis for successful commands (exit 0)
- [ ] Rate limiting: rapid failures don't spam Ollama

AI Suggestions:
- [ ] Type partial command → history match appears as gray ghost text
- [ ] Right Arrow accepts the suggestion
- [ ] Escape dismisses
- [ ] No suggestion when input doesn't match history
- [ ] `?find large files` → on Enter, AI generates command as ghost text
- [ ] AI suggestion shows ✨ indicator
- [ ] Config `suggest_enabled = false` disables suggestions

Semantic Search:
- [ ] Ctrl+R opens search overlay
- [ ] Type natural language query → results from history
- [ ] Enter inserts selected command at cursor
- [ ] Escape closes search
- [ ] Works without Ollama (falls back to fuzzy text match)
- [ ] History persists across sessions (saved to disk)
