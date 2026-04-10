# Kōji Baseline v0.3 — Design Specification

> DOM overlay system, interactive menus, theme stability fix, and a full developer agent with split-pane UI and multi-provider open-source LLM support.

## Overview

Four interconnected improvements that transform Kōji Baseline from a terminal with LLM chat into a terminal with a full developer agent. The overlay system fixes the output-blocking bug and enables interactive menus. The theme fix resolves crashes and colour propagation. The agent system introduces a split-pane agentic workflow with tool use, permission controls, and support for local and cloud-hosted open-source models.

## Feature 1: DOM Overlay System

### Problem

Command and LLM output currently paints directly onto the Canvas via `setLlmResponse()`. Canvas redraws (from terminal output, cursor animation) immediately overwrite this content, causing visual conflicts.

### Solution

Replace Canvas-painted overlays with a DOM layer (`<div class="terminal-overlay">`) absolutely positioned over the Canvas inside `.terminal-viewport`.

**Architecture:**
- `src/overlay/overlay.ts` — manages overlay lifecycle
- Content renders as HTML elements styled with `--koji-*` CSS variables
- Transparent by default — Canvas shows through
- When content appears (command output, menu, LLM response), elements have a semi-transparent theme-void background
- Content auto-dismisses when the user starts typing a new command

**Replaces:** `setLlmResponse()` in grid.ts, which is removed entirely. All non-terminal visual content goes through the overlay.

**Overlay content types:**
- `showMessage(text, isError)` — styled text block for command output
- `showMenu(options, onSelect)` — interactive selection list
- `dismiss()` — clear overlay content

## Feature 2: Interactive Menus

### Behaviour

Commands with selectable options show a navigable menu in the overlay instead of text output.

**Applicable commands:**
- `/theme` — list of 6 themes with live preview
- `/llm models` — list of available models
- `/llm provider` — list of configured providers

**Controls:**
- `↑` / `↓` — move highlight cursor
- `Enter` — select and apply
- `Escape` — cancel and dismiss
- Typing filters the list (simple substring match)

**Live preview for `/theme`:**
As the user arrows through theme options, the CSS variables update to show a preview. If they press Escape, the original theme is restored. Enter commits the selection.

### Menu Data Structure

```typescript
interface MenuItem {
  label: string;
  value: string;
  description?: string;
  active?: boolean; // marks the current selection
}

interface MenuResult {
  type: "menu";
  items: MenuItem[];
  onSelect: (value: string) => Promise<void>;
  onPreview?: (value: string) => void;
  onCancel?: () => void;
}
```

Command handlers return either `CommandResult` (text) or `MenuResult` (interactive list). The overlay system renders whichever it receives.

## Feature 3: Theme Stability Fix

### Root Cause 1 — Deadlock/Crash

`set_theme_colors` locks `EngineState` via `std::sync::Mutex` on the main thread. The I/O thread also locks it continuously. Under contention this can deadlock.

**Fix:** Replace `std::sync::Mutex` wrapping the engine state with `parking_lot::Mutex` (already a dependency). `parking_lot::Mutex` is non-poisoning, faster under contention, and won't deadlock in this pattern.

### Root Cause 2 — Colours Don't Change

The override map uses keys like `"red"` but `named_to_rgb` matches against `NamedColor::Red`, `NamedColor::BrightRed`, `NamedColor::DimRed` separately. Only the base variant matches.

**Fix:** When `"red"` is set in the override map, apply it to Red, BrightRed, and DimRed. Same for all colours. The `named_to_rgb` function maps all Bright/Dim variants to their base key before looking up the override.

### Forced Redraw

After `set_theme_colors` completes, emit a `"theme-applied"` event from the backend. The frontend listens for this and forces a full grid redraw by re-requesting a snapshot.

## Feature 4: Developer Agent System

### Provider Abstraction

All providers implement the same interface — a streaming chat endpoint with tool definitions.

**Supported providers:**

| Provider | Type | API Format | Models |
|----------|------|-----------|--------|
| Ollama | Local | Ollama native | Any pulled model |
| Together.ai | Cloud | OpenAI-compatible | Qwen, DeepSeek, Llama, Mistral |
| Groq | Cloud | OpenAI-compatible | Llama, Mistral |
| Fireworks.ai | Cloud | OpenAI-compatible | Qwen, DeepSeek, Llama |

**Provider interface:**
```typescript
interface LlmProvider {
  name: string;
  chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
  ): AsyncIterable<StreamChunk>;
  listModels(): Promise<string[]>;
}
```

Two Rust-side implementations (exposed via Tauri commands, called from TypeScript provider wrappers):
- `OllamaProvider` — refactored from existing `ollama.rs` client
- `OpenAICompatibleProvider` — handles Together, Groq, Fireworks (same `/v1/chat/completions` API, different base URLs and API keys). Lives in `src-tauri/src/openai_compat.rs`

Both stream responses via Tauri events, same pattern as the existing Ollama client.

### Configuration

Stored in `~/.koji-baseline/config.json`:

```json
{
  "theme": "wallace",
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434" },
    "together": { "baseUrl": "https://api.together.xyz/v1", "apiKey": "tok_..." },
    "groq": { "baseUrl": "https://api.groq.com/openai/v1", "apiKey": "gsk_..." }
  },
  "activeProvider": "ollama",
  "activeModel": "qwen2.5-coder:32b",
  "autorun": "off"
}
```

`/help` includes instructions on how to add providers by editing the config file.

### Agent Tools

The agent has access to a full developer toolkit:

| Tool | Description | Autorun: safe |
|------|-------------|:---:|
| `run_command` | Execute a shell command, return stdout/stderr | No |
| `read_file` | Read file contents (optional line range) | Yes |
| `write_file` | Create or overwrite a file | No |
| `edit_file` | Find-and-replace edit within a file | No |
| `list_directory` | List files/dirs (optional recursion) | Yes |
| `search_files` | Regex pattern search across files | Yes |
| `search_filenames` | Find files by glob pattern | Yes |
| `git_status` | Get branch, changes, staged state | Yes |
| `git_diff` | Show diff for files or staged changes | Yes |
| `open_browser` | Open URL in default browser | No |
| `fetch_url` | HTTP GET a URL, return content | Yes |

Tools are defined as JSON Schema and sent to the LLM provider as part of the chat request (Ollama and OpenAI-compatible APIs both support tool definitions).

### Autorun Permission Levels

| Level | Behaviour | Set with |
|-------|-----------|----------|
| `off` (default) | All tool calls require Enter to approve | `/llm autorun off` |
| `safe` | Read-only tools auto-approve; write/execute tools ask | `/llm autorun safe` |
| `full` | All tools auto-approve (shows warning on activation) | `/llm autorun full` |

Warning on activating `full`:
```
⚠ Full autorun enabled — the agent will execute ALL commands without asking.
  This includes file writes, shell commands, and git operations.
  Use /llm autorun off to restore approval prompts.
```

### Split-Pane UI

**Activation:** `/agent` opens the agent pane. `Escape` or `/exit` closes it.

**Layout:**
- Terminal viewport splits ~60% left (terminal), ~40% right (agent)
- Vertical divider between panes, styled with theme's `dim` colour
- Left pane: normal terminal, fully functional, PTY stays active
- Right pane: agent conversation — scrollable HTML, themed
- Click either pane to focus it. Focused pane receives keyboard input.

**Right pane structure:**
- Model badge at top: `🤖 qwen2.5-coder:32b via ollama`
- Scrollable conversation area: alternating user messages and agent responses
- Tool call blocks: show the proposed action with `[Enter] approve [Esc] reject [e] edit` controls
- Tool results: show stdout/stderr in a code block
- Input field at bottom: styled prompt `you ›` with blinking cursor

**When closed:** Terminal returns to full width. Agent conversation state is preserved — reopening `/agent` continues where you left off.

**Quick queries:** `>>` still works outside of agent mode for one-shot questions. These use the active provider/model but don't open the split pane and don't have tool access.

### Agent Conversation Flow

1. User types message in agent pane input
2. Message + conversation history + tool definitions sent to active provider
3. Provider streams response — text appears in agent pane
4. If provider requests a tool call:
   a. Tool call block appears with approve/reject UI
   b. `off` mode: waits for Enter/Escape
   c. `safe` mode: auto-approves if tool is read-only, otherwise waits
   d. `full` mode: auto-approves immediately
5. On approval: tool executes via Tauri command, result returned to provider
6. On rejection: "Tool call rejected by user" sent to provider
7. Provider continues responding with tool results
8. Loop until provider sends final message (no more tool calls)

### Recommended Models

Shown in `/help` and on first `/agent` launch:

| Model | Size | Best For | Tool Use |
|-------|------|----------|----------|
| Qwen2.5-Coder-32B | 32B | Code generation, refactoring | Excellent |
| Qwen2.5-Coder-7B | 7B | Fast code tasks, lightweight | Good |
| DeepSeek-Coder-V2 | 16B/236B | Complex reasoning, debugging | Excellent |
| Llama-3.3-70B | 70B | General dev + reasoning | Good |
| Mistral-Small | 22B | Fast all-rounder | Good |
| CodeGemma-7B | 7B | Quick code completion | Basic |

**Cloud providers hosting these:**
- Together.ai — Qwen, DeepSeek, Llama, Mistral
- Groq — Llama, Mistral (ultra-fast inference)

First `/agent` launch shows: "For best results, use a model with tool-use support. Run `/llm recommend` for suggestions."

### Updated Command Table

| Command | Action |
|---------|--------|
| `/help` | Show all commands + recommended models |
| `/version` | Show version |
| `/theme` | Interactive theme picker (arrow keys) |
| `/theme <name>` | Switch theme directly |
| `/agent` | Open agent split pane |
| `/exit` | Close agent pane |
| `/llm connect` | Check provider connection status |
| `/llm provider` | Interactive provider picker |
| `/llm provider <name>` | Switch provider directly |
| `/llm model` | Interactive model picker |
| `/llm model <name>` | Switch model directly |
| `/llm models` | List available models |
| `/llm pull <name>` | Pull model (Ollama only) |
| `/llm autorun off\|safe\|full` | Set tool approval level |
| `/llm recommend` | Show recommended models table |

## Project Structure (New/Modified Files)

```
src/overlay/
  overlay.ts         — DOM overlay manager (replaces setLlmResponse)
  menu.ts            — interactive arrow-key menu component
src/agent/
  agent.ts           — agent session manager, conversation loop
  tools.ts           — tool definitions and execution
  pane.ts            — split-pane UI, right-side conversation renderer
  permissions.ts     — autorun permission checker
src/providers/
  provider.ts        — LlmProvider interface
  ollama.ts          — Ollama provider (refactored from llm/panel.ts)
  openai-compat.ts   — OpenAI-compatible provider (Together, Groq, Fireworks)
src/commands/
  router.ts          — updated to return MenuResult | CommandResult
  handlers.ts        — updated with new commands, menu returns
```

## Non-Goals (v0.3)

- Streaming tool call display (show tool calls one at a time, not batched)
- Agent memory/context persistence across sessions
- MCP (Model Context Protocol) support
- Voice input
- Image/vision support
- Agent-to-agent delegation
