// pane.ts — Agent split-pane UI (v2)
// LEFT:  Conversation — [User] and [Agent] messages, input at bottom
//        User can also run shell commands with $ prefix
// RIGHT: Workspace — read-only scrollable log of agent actions (tool calls, output)
// AgentSession drives the data; AgentPane owns both panes.

import { AgentSession, type AgentEvent } from "./agent";
import { getActiveProvider } from "../providers/provider";
import { invoke } from "@tauri-apps/api/core";

// ─── ASCII art for User and Agent labels ─────────────────────────────────────

const USER_GLYPH = "◆";
const AGENT_GLYPH = "◇";

export class AgentPane {
  private session: AgentSession | null = null;
  private wrapperEl: HTMLDivElement | null = null;
  private chatEl: HTMLDivElement | null = null;
  private workspaceEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private _isOpen = false;

  // Track pending tool block in workspace
  private pendingToolEl: HTMLDivElement | null = null;

  // Capture-phase keydown handler
  private captureHandler: ((e: KeyboardEvent) => void) | null = null;

  // Original container children to restore on close
  private originalChildren: Node[] = [];

  get isOpen(): boolean {
    return this._isOpen;
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this._isOpen) return;

    const container = document.getElementById("terminal-container");
    if (!container) throw new Error("#terminal-container not found");

    // Save original children (canvas, overlay) to restore on close
    this.originalChildren = Array.from(container.childNodes);

    // Hide original terminal content
    for (const child of this.originalChildren) {
      if (child instanceof HTMLElement) child.style.display = "none";
    }

    // ── Build the agent wrapper ──────────────────────────────────────────────
    const wrapper = document.createElement("div");
    wrapper.className = "agent-wrapper";
    container.appendChild(wrapper);
    this.wrapperEl = wrapper;

    // ── LEFT: Conversation pane ──────────────────────────────────────────────
    const chatPane = document.createElement("div");
    chatPane.className = "agent-chat-pane";

    // Chat header
    const chatHeader = document.createElement("div");
    chatHeader.className = "agent-chat-header";

    let modelLabel = "agent";
    try {
      const provider = await getActiveProvider();
      const model = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
      modelLabel = model || provider.name;
    } catch {}

    chatHeader.innerHTML = `<span class="agent-chat-title">${AGENT_GLYPH} Kōji Agent</span><span class="agent-chat-model">${modelLabel}</span>`;
    chatPane.appendChild(chatHeader);

    // Chat messages area
    const chatMessages = document.createElement("div");
    chatMessages.className = "agent-chat-messages";
    chatPane.appendChild(chatMessages);
    this.chatEl = chatMessages;

    // Welcome message
    this.appendAgentMsg("Welcome to Kōji Agent. Ask me anything, or type `$ command` to run a shell command directly.");

    // Chat input area
    const inputArea = document.createElement("div");
    inputArea.className = "agent-chat-input-area";

    const promptLabel = document.createElement("span");
    promptLabel.className = "agent-chat-prompt";
    promptLabel.textContent = `${USER_GLYPH}`;
    inputArea.appendChild(promptLabel);

    const input = document.createElement("input");
    input.className = "agent-chat-input";
    input.type = "text";
    input.placeholder = "message the agent...";
    input.autocomplete = "off";
    input.spellcheck = false;
    inputArea.appendChild(input);
    this.inputEl = input;

    chatPane.appendChild(inputArea);
    wrapper.appendChild(chatPane);

    // ── Divider ──────────────────────────────────────────────────────────────
    const divider = document.createElement("div");
    divider.className = "agent-divider";
    wrapper.appendChild(divider);

    // ── RIGHT: Workspace pane ────────────────────────────────────────────────
    const workspacePane = document.createElement("div");
    workspacePane.className = "agent-workspace-pane";

    const wsHeader = document.createElement("div");
    wsHeader.className = "agent-ws-header";
    wsHeader.textContent = "⚙ Workspace";
    workspacePane.appendChild(wsHeader);

    const wsLog = document.createElement("div");
    wsLog.className = "agent-ws-log";
    workspacePane.appendChild(wsLog);
    this.workspaceEl = wsLog;

    wrapper.appendChild(workspacePane);

    // ── Session ───────────────────────────────────────────────────────────────
    const provider = await getActiveProvider();
    this.session = new AgentSession(provider);
    this.session.on((event) => this.handleEvent(event));

    // ── Input handling ────────────────────────────────────────────────────────
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.submitInput();
      }
    });

    // Capture-phase: intercept keys for tool approval when pending
    this.captureHandler = (e: KeyboardEvent) => {
      if (!this.pendingToolEl) return;

      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.markToolApproved();
        this.session?.resolveToolApproval(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.markToolRejected();
        this.session?.resolveToolApproval(false);
      }
    };
    window.addEventListener("keydown", this.captureHandler, { capture: true });

    this._isOpen = true;

    // Focus the input
    setTimeout(() => input.focus(), 50);
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  close(): void {
    if (!this._isOpen) return;

    const container = document.getElementById("terminal-container");
    if (!container) return;

    // Remove agent wrapper
    if (this.wrapperEl) {
      container.removeChild(this.wrapperEl);
    }

    // Restore original children
    for (const child of this.originalChildren) {
      if (child instanceof HTMLElement) child.style.display = "";
    }

    // Dismiss any leftover overlay content so it doesn't cover the terminal
    import("../overlay/overlay").then(({ overlay }) => {
      overlay.dismiss();
    }).catch(() => {});

    // Resize terminal back to full width
    import("../main").then(({ domGrid }) => {
      const { rows, cols } = domGrid.measureGrid();
      domGrid.resize(rows, cols);
      invoke("resize_terminal", { rows, cols }).catch(console.warn);
    }).catch(console.warn);

    // Remove capture handler
    if (this.captureHandler) {
      window.removeEventListener("keydown", this.captureHandler, { capture: true });
      this.captureHandler = null;
    }

    this.wrapperEl = null;
    this.chatEl = null;
    this.workspaceEl = null;
    this.inputEl = null;
    this.pendingToolEl = null;
    this._isOpen = false;
  }

  // ── Event handler ─────────────────────────────────────────────────────────

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        this.appendStreamText(event.content ?? "");
        break;

      case "tool_request":
        if (event.toolCall) {
          // Tool requests go to BOTH panes:
          // - Chat: brief note that agent is using a tool
          // - Workspace: full tool block with details
          this.appendAgentMsg(`Using tool: ${event.toolCall.function.name}...`);
          this.pendingToolEl = this.appendWorkspaceTool(
            event.toolCall.function.name,
            event.toolCall.function.arguments,
          );
        }
        break;

      case "tool_approved":
        break;

      case "tool_result":
        if (this.pendingToolEl && event.toolResult !== undefined) {
          this.appendWorkspaceResult(this.pendingToolEl, event.toolResult);
          this.pendingToolEl = null;
        }
        break;

      case "tool_rejected":
        this.pendingToolEl = null;
        break;

      case "done":
        this.sealStreamBubble();
        break;

      case "error":
        this.appendChatError(event.content ?? "Unknown error");
        this.appendWorkspaceError(event.content ?? "Unknown error");
        break;
    }
  }

  // ── Chat pane rendering (LEFT) ────────────────────────────────────────────

  private appendUserMsg(text: string): void {
    if (!this.chatEl) return;
    const div = document.createElement("div");
    div.className = "agent-chat-msg agent-chat-msg-user";
    div.innerHTML = `<span class="chat-role chat-role-user">${USER_GLYPH} User</span>`;
    const body = document.createElement("div");
    body.className = "chat-body";
    body.textContent = text;
    div.appendChild(body);
    this.chatEl.appendChild(div);
    this.scrollChat();
  }

  private appendAgentMsg(text: string): void {
    if (!this.chatEl) return;
    const div = document.createElement("div");
    div.className = "agent-chat-msg agent-chat-msg-agent";
    div.innerHTML = `<span class="chat-role chat-role-agent">${AGENT_GLYPH} Agent</span>`;
    const body = document.createElement("div");
    body.className = "chat-body";
    body.textContent = text;
    div.appendChild(body);
    this.chatEl.appendChild(div);
    this.scrollChat();
  }

  // Streaming text
  private streamBubble: HTMLDivElement | null = null;
  private streamBody: HTMLDivElement | null = null;
  private streamAccum = "";

  private appendStreamText(chunk: string): void {
    if (!this.chatEl) return;

    if (!this.streamBubble) {
      const div = document.createElement("div");
      div.className = "agent-chat-msg agent-chat-msg-agent";
      div.innerHTML = `<span class="chat-role chat-role-agent">${AGENT_GLYPH} Agent</span>`;
      const body = document.createElement("div");
      body.className = "chat-body";
      div.appendChild(body);
      this.chatEl.appendChild(div);
      this.streamBubble = div;
      this.streamBody = body;
      this.streamAccum = "";
    }

    this.streamAccum += chunk;
    if (this.streamBody) this.streamBody.textContent = this.streamAccum;
    this.scrollChat();
  }

  private sealStreamBubble(): void {
    this.streamBubble = null;
    this.streamBody = null;
    this.streamAccum = "";
  }

  private appendChatError(message: string): void {
    if (!this.chatEl) return;
    const div = document.createElement("div");
    div.className = "agent-chat-msg agent-chat-msg-error";
    div.textContent = `⚠ ${message}`;
    this.chatEl.appendChild(div);
    this.scrollChat();
  }

  private scrollChat(): void {
    if (this.chatEl) this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  // ── Workspace pane rendering (RIGHT) ──────────────────────────────────────

  private appendWorkspaceTool(name: string, argsJson: string): HTMLDivElement {
    if (!this.workspaceEl) return document.createElement("div");

    const block = document.createElement("div");
    block.className = "agent-ws-tool";

    const nameEl = document.createElement("div");
    nameEl.className = "ws-tool-name";
    nameEl.textContent = `⚙ ${name}`;
    block.appendChild(nameEl);

    let argsFormatted = argsJson;
    try {
      argsFormatted = JSON.stringify(JSON.parse(argsJson), null, 2);
    } catch {}

    const argsEl = document.createElement("pre");
    argsEl.className = "ws-tool-args";
    argsEl.textContent = argsFormatted;
    block.appendChild(argsEl);

    const controls = document.createElement("div");
    controls.className = "ws-tool-controls";
    controls.textContent = "[Enter] approve   [Esc] reject";
    block.appendChild(controls);

    this.workspaceEl.appendChild(block);
    this.scrollWorkspace();
    return block;
  }

  private markToolApproved(): void {
    if (!this.pendingToolEl) return;
    const controls = this.pendingToolEl.querySelector(".ws-tool-controls");
    if (controls) controls.textContent = "✔ approved — executing…";
  }

  private markToolRejected(): void {
    if (!this.pendingToolEl) return;
    const controls = this.pendingToolEl.querySelector(".ws-tool-controls");
    if (controls) controls.textContent = "✘ rejected";
  }

  private appendWorkspaceResult(block: HTMLDivElement, result: string): void {
    const controls = block.querySelector(".ws-tool-controls");
    if (controls) controls.textContent = "✔ done";

    const resultEl = document.createElement("pre");
    resultEl.className = "ws-tool-result";
    resultEl.textContent = result;
    block.appendChild(resultEl);
    this.scrollWorkspace();
  }

  private appendWorkspaceError(message: string): void {
    if (!this.workspaceEl) return;
    const div = document.createElement("div");
    div.className = "ws-error";
    div.textContent = `⚠ ${message}`;
    this.workspaceEl.appendChild(div);
    this.scrollWorkspace();
  }

  private scrollWorkspace(): void {
    if (this.workspaceEl) this.workspaceEl.scrollTop = this.workspaceEl.scrollHeight;
  }

  // ── Input handling ────────────────────────────────────────────────────────

  private async submitInput(): Promise<void> {
    if (!this.inputEl || !this.session) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";

    // $ prefix = run shell command directly
    if (text.startsWith("$ ")) {
      const cmd = text.slice(2);
      this.appendUserMsg(text);
      try {
        const result = await invoke<string>("agent_run_command", { command: cmd });
        this.appendAgentMsg(result || "(no output)");
        // Also show in workspace
        this.appendWorkspaceCmd(cmd, result);
      } catch (e) {
        this.appendChatError(`Command failed: ${e}`);
      }
      return;
    }

    // Regular message to agent
    this.appendUserMsg(text);
    this.sealStreamBubble();

    this.session.sendMessage(text).catch((err) => {
      this.appendChatError(String(err));
    });
  }

  /** Show a direct shell command in the workspace log */
  private appendWorkspaceCmd(cmd: string, output: string): void {
    if (!this.workspaceEl) return;
    const block = document.createElement("div");
    block.className = "agent-ws-tool";

    const cmdEl = document.createElement("div");
    cmdEl.className = "ws-tool-name";
    cmdEl.textContent = `$ ${cmd}`;
    block.appendChild(cmdEl);

    if (output) {
      const outEl = document.createElement("pre");
      outEl.className = "ws-tool-result";
      outEl.textContent = output;
      block.appendChild(outEl);
    }

    this.workspaceEl.appendChild(block);
    this.scrollWorkspace();
  }
}

/** Singleton — handlers.ts calls agentPane.open() / agentPane.close(). */
export const agentPane = new AgentPane();
