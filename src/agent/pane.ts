// pane.ts — Agent split-pane UI
// Manages the side-by-side terminal + agent conversation layout.
// AgentSession drives the data; AgentPane owns the DOM.

import { AgentSession, type AgentEvent } from "./agent";
import { getActiveProvider } from "../providers/provider";

export class AgentPane {
  private session: AgentSession | null = null;
  private paneEl: HTMLDivElement | null = null;
  private dividerEl: HTMLDivElement | null = null;
  private conversationEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private _isOpen = false;

  // Track pending tool block element so we can update it on result
  private pendingToolEl: HTMLDivElement | null = null;

  // Capture-phase keydown handler — stored so we can remove it on close
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  get isOpen(): boolean {
    return this._isOpen;
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this._isOpen) return;

    const container = document.getElementById("terminal-container");
    if (!container) throw new Error("#terminal-container not found");

    // Make the viewport a flex row
    container.style.display = "flex";
    container.style.flexDirection = "row";
    container.style.alignItems = "stretch";

    // Shrink the canvas to 60 %
    const canvas = container.querySelector("canvas");
    if (canvas) {
      (canvas as HTMLElement).style.flexShrink = "0";
      (canvas as HTMLElement).style.width = "60%";
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    const divider = document.createElement("div");
    divider.className = "agent-divider";
    container.appendChild(divider);
    this.dividerEl = divider;

    // ── Agent pane ────────────────────────────────────────────────────────────
    const pane = document.createElement("div");
    pane.className = "agent-pane";
    container.appendChild(pane);
    this.paneEl = pane;

    // Build provider / model label
    let headerLabel = "🤖 agent";
    try {
      const provider = await getActiveProvider();
      // Try to grab model name from config (best-effort)
      const { invoke } = await import("@tauri-apps/api/core");
      const model = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
      const providerName = provider.name;
      headerLabel = `🤖 ${model || providerName} via ${providerName}`;
    } catch {
      // Silently fall back — header label stays generic
    }

    // Header
    const header = document.createElement("div");
    header.className = "agent-header";
    header.textContent = headerLabel;
    pane.appendChild(header);

    // Conversation area
    const conv = document.createElement("div");
    conv.className = "agent-conversation";
    pane.appendChild(conv);
    this.conversationEl = conv;

    // Input area
    const inputArea = document.createElement("div");
    inputArea.className = "agent-input-area";

    const promptLabel = document.createElement("span");
    promptLabel.className = "prompt-label";
    promptLabel.textContent = "you ›";
    inputArea.appendChild(promptLabel);

    const input = document.createElement("input");
    input.className = "agent-input";
    input.type = "text";
    input.placeholder = "type a message…";
    inputArea.appendChild(input);
    this.inputEl = input;

    pane.appendChild(inputArea);

    // ── Session ───────────────────────────────────────────────────────────────
    const provider = await getActiveProvider();
    this.session = new AgentSession(provider);
    this.session.on((event) => this.handleEvent(event));

    // ── Click-to-focus ────────────────────────────────────────────────────────
    pane.addEventListener("click", () => input.focus());
    if (canvas) {
      (canvas as HTMLElement).addEventListener("click", () => input.blur());
    }

    // ── Input — send on Enter ─────────────────────────────────────────────────
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.submitInput();
      }
    });

    // ── Capture-phase handler — intercept Enter/Escape for tool approval ──────
    // Runs before the global keydown in main.ts so tool approval doesn't leak
    // to the PTY.
    this.captureHandler = (e: KeyboardEvent) => {
      if (!this.session) return;

      // Only intercept when the pane input is focused and we have a pending tool
      if (document.activeElement !== input) return;
      if (!(this.session as unknown as { pendingToolApproval: unknown }).pendingToolApproval) {
        // Access the private field through the resolveToolApproval path:
        // We check by inspecting whether pendingToolEl exists (set when we render a tool block)
        if (!this.pendingToolEl) return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (this.pendingToolEl) {
          this.markToolApproved();
          this.session!.resolveToolApproval(true);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (this.pendingToolEl) {
          this.markToolRejected();
          this.session!.resolveToolApproval(false);
        }
      }
    };
    window.addEventListener("keydown", this.captureHandler, { capture: true });

    this._isOpen = true;
    input.focus();

    // Replay any existing conversation history (if pane was re-opened)
    // Nothing to replay on fresh session — history is empty.
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  close(): void {
    if (!this._isOpen) return;

    const container = document.getElementById("terminal-container");
    if (!container) return;

    // Remove pane and divider
    if (this.paneEl) container.removeChild(this.paneEl);
    if (this.dividerEl) container.removeChild(this.dividerEl);

    // Restore canvas width
    const canvas = container.querySelector("canvas");
    if (canvas) {
      (canvas as HTMLElement).style.width = "100%";
      (canvas as HTMLElement).style.flexShrink = "";
    }

    // Restore container layout
    container.style.display = "";
    container.style.flexDirection = "";
    container.style.alignItems = "";

    // Remove capture handler
    if (this.captureHandler) {
      window.removeEventListener("keydown", this.captureHandler, { capture: true });
      this.captureHandler = null;
    }

    this.paneEl = null;
    this.dividerEl = null;
    this.conversationEl = null;
    this.inputEl = null;
    this.pendingToolEl = null;
    this._isOpen = false;

    // NOTE: session is intentionally kept alive — AgentSession holds conversation
    // history. Re-opening the pane will create a fresh session but the old one's
    // history could be wired in here if needed later.
  }

  // ── Event handler ─────────────────────────────────────────────────────────

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        this.appendStreamText(event.content ?? "");
        break;

      case "tool_request":
        if (event.toolCall) {
          this.pendingToolEl = this.appendToolBlock(event.toolCall.function.name, event.toolCall.function.arguments);
        }
        break;

      case "tool_approved":
        // Controls updated inline by markToolApproved
        break;

      case "tool_result":
        if (this.pendingToolEl && event.toolResult !== undefined) {
          this.appendToolResult(this.pendingToolEl, event.toolResult);
          this.pendingToolEl = null;
        }
        break;

      case "tool_rejected":
        // markToolRejected already updated the block
        this.pendingToolEl = null;
        break;

      case "done":
        // Seal the last streaming bubble
        this.sealStreamBubble();
        break;

      case "error":
        this.appendError(event.content ?? "Unknown error");
        break;
    }
  }

  // ── Conversation rendering ─────────────────────────────────────────────────

  /** Add a user message bubble. */
  private appendUserMsg(text: string): void {
    const div = document.createElement("div");
    div.className = "agent-msg agent-msg-user";
    div.textContent = text;
    this.conversationEl?.appendChild(div);
    this.scrollToBottom();
  }

  // Active streaming bubble element
  private streamBubble: HTMLDivElement | null = null;
  private streamAccum = "";

  /** Append a chunk of streamed assistant text. */
  private appendStreamText(chunk: string): void {
    if (!this.conversationEl) return;

    if (!this.streamBubble) {
      const div = document.createElement("div");
      div.className = "agent-msg agent-msg-assistant";
      this.conversationEl.appendChild(div);
      this.streamBubble = div;
      this.streamAccum = "";
    }

    this.streamAccum += chunk;
    this.streamBubble.textContent = this.streamAccum;
    this.scrollToBottom();
  }

  /** Called on "done" — clears the active streaming bubble reference. */
  private sealStreamBubble(): void {
    this.streamBubble = null;
    this.streamAccum = "";
  }

  /** Render a tool request block. Returns the element so results can update it. */
  private appendToolBlock(name: string, argsJson: string): HTMLDivElement {
    const block = document.createElement("div");
    block.className = "agent-tool-block";

    const nameEl = document.createElement("div");
    nameEl.className = "tool-name";
    nameEl.textContent = `⚙ ${name}`;
    block.appendChild(nameEl);

    let argsFormatted = argsJson;
    try {
      argsFormatted = JSON.stringify(JSON.parse(argsJson), null, 2);
    } catch {
      // Raw string fallback
    }

    const argsEl = document.createElement("pre");
    argsEl.className = "tool-args";
    argsEl.textContent = argsFormatted;
    block.appendChild(argsEl);

    const controls = document.createElement("div");
    controls.className = "tool-controls";
    controls.textContent = "[Enter] approve   [Esc] reject";
    block.appendChild(controls);

    this.conversationEl?.appendChild(block);
    this.scrollToBottom();
    return block;
  }

  /** Update tool block controls to reflect approval. */
  private markToolApproved(): void {
    if (!this.pendingToolEl) return;
    const controls = this.pendingToolEl.querySelector(".tool-controls");
    if (controls) controls.textContent = "✔ approved — executing…";
  }

  /** Update tool block controls to reflect rejection. */
  private markToolRejected(): void {
    if (!this.pendingToolEl) return;
    const controls = this.pendingToolEl.querySelector(".tool-controls");
    if (controls) controls.textContent = "✘ rejected";
  }

  /** Append tool result inside the tool block. */
  private appendToolResult(block: HTMLDivElement, result: string): void {
    const controls = block.querySelector(".tool-controls");
    if (controls) controls.textContent = "✔ done";

    const resultEl = document.createElement("pre");
    resultEl.className = "tool-result";
    resultEl.textContent = result;
    block.appendChild(resultEl);
    this.scrollToBottom();
  }

  /** Append a red error message. */
  private appendError(message: string): void {
    if (!this.conversationEl) return;
    const div = document.createElement("div");
    div.className = "agent-msg";
    div.style.color = "var(--koji-error)";
    div.textContent = `⚠ ${message}`;
    this.conversationEl.appendChild(div);
    this.scrollToBottom();
  }

  /** Scroll the conversation area to the very bottom. */
  private scrollToBottom(): void {
    if (this.conversationEl) {
      this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
    }
  }

  // ── Input handling ────────────────────────────────────────────────────────

  private submitInput(): void {
    if (!this.inputEl || !this.session) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.appendUserMsg(text);
    this.sealStreamBubble(); // start fresh bubble for assistant reply

    this.session.sendMessage(text).catch((err) => {
      this.appendError(String(err));
    });
  }
}

/** Singleton — handlers.ts calls agentPane.open() / agentPane.close(). */
export const agentPane = new AgentPane();
