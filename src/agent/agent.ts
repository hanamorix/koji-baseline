// agent.ts — Agent session manager
// Runs the conversation loop: user message → provider stream → tool calls → loop.

import type {
  LlmProvider,
  ChatMessage,
  ToolCall,
} from "../providers/provider";
import { AGENT_TOOLS, executeTool } from "./tools";
import { getAutorunLevel, shouldAutoApprove, type AutorunLevel } from "./permissions";

export type AgentEventType =
  | "text"           // streaming text from the model
  | "tool_request"   // model wants to call a tool — needs approval
  | "tool_approved"  // tool was approved and is executing
  | "tool_result"    // tool execution finished
  | "tool_rejected"  // user rejected the tool call
  | "done"           // model finished responding
  | "error";         // something went wrong

export interface AgentEvent {
  type: AgentEventType;
  content?: string;
  toolCall?: ToolCall;
  toolResult?: string;
}

type AgentListener = (event: AgentEvent) => void;

export class AgentSession {
  private provider: LlmProvider;
  private messages: ChatMessage[] = [];
  private listeners: AgentListener[] = [];
  private pendingToolApproval: {
    toolCall: ToolCall;
    resolve: (approved: boolean) => void;
  } | null = null;
  private _isRunning = false;

  constructor(provider: LlmProvider) {
    this.provider = provider;
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get conversationHistory(): ChatMessage[] {
    return [...this.messages];
  }

  /** Register a listener for agent events. */
  on(listener: AgentListener): void {
    this.listeners.push(listener);
  }

  /** Remove a listener. */
  off(listener: AgentListener): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Send a user message and run the conversation loop. */
  async sendMessage(userMessage: string): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;

    this.messages.push({ role: "user", content: userMessage });

    try {
      await this.runLoop();
    } catch (err) {
      this.emit({ type: "error", content: String(err) });
    } finally {
      this._isRunning = false;
    }
  }

  /** Approve or reject a pending tool call. */
  resolveToolApproval(approved: boolean): void {
    if (this.pendingToolApproval) {
      this.pendingToolApproval.resolve(approved);
      this.pendingToolApproval = null;
    }
  }

  /** Main conversation loop — streams response, handles tool calls, loops. */
  private async runLoop(): Promise<void> {
    const autorunLevel: AutorunLevel = await getAutorunLevel();

    // Add system message if this is the first message
    if (this.messages.length === 1) {
      this.messages.unshift({
        role: "system",
        content:
          "You are a developer agent running inside Koji Baseline, a terminal emulator. " +
          "You have access to tools for reading/writing files, running commands, searching code, and browsing. " +
          "Use tools to help the user with their development tasks. Be concise and precise.",
      });
    }

    let loopCount = 0;
    const maxLoops = 20; // safety limit

    while (loopCount < maxLoops) {
      loopCount++;

      // Stream response from provider
      let accumulatedText = "";
      const toolCalls: ToolCall[] = [];

      const stream = this.provider.chatStream(this.messages, AGENT_TOOLS);
      for await (const chunk of stream) {
        switch (chunk.type) {
          case "text":
            accumulatedText += chunk.content ?? "";
            this.emit({ type: "text", content: chunk.content ?? "" });
            break;
          case "tool_call":
            if (chunk.tool_call) {
              toolCalls.push(chunk.tool_call);
            }
            break;
          case "error":
            this.emit({ type: "error", content: chunk.error ?? "Unknown error" });
            return;
          case "done":
            break;
        }
      }

      // Add assistant message to history
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: accumulatedText,
      };
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      this.messages.push(assistantMessage);

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        this.emit({ type: "done" });
        return;
      }

      // Process tool calls one at a time
      for (const toolCall of toolCalls) {
        const approved = await this.requestToolApproval(toolCall, autorunLevel);

        if (approved) {
          this.emit({ type: "tool_approved", toolCall });
          let result: string;
          try {
            result = await executeTool(
              toolCall.function.name,
              JSON.parse(toolCall.function.arguments),
            );
          } catch (e) {
            result = `Tool execution failed: ${e}`;
            this.emit({ type: "error", content: result });
          }
          this.emit({ type: "tool_result", toolCall, toolResult: result });

          // Add tool result to conversation
          this.messages.push({
            role: "tool",
            content: result,
            tool_call_id: toolCall.id,
          });
        } else {
          this.emit({ type: "tool_rejected", toolCall });
          this.messages.push({
            role: "tool",
            content: "Tool call rejected by user.",
            tool_call_id: toolCall.id,
          });
        }
      }

      // Continue loop — model will respond to tool results
    }

    this.emit({ type: "error", content: "Agent loop exceeded maximum iterations." });
  }

  /** Request approval for a tool call based on autorun level. */
  private async requestToolApproval(
    toolCall: ToolCall,
    level: AutorunLevel,
  ): Promise<boolean> {
    if (shouldAutoApprove(toolCall.function.name, level)) {
      return true;
    }

    // Emit tool_request and wait for user approval
    this.emit({ type: "tool_request", toolCall });
    return new Promise<boolean>((resolve) => {
      this.pendingToolApproval = { toolCall, resolve };
    });
  }

  /** Reset conversation history. */
  reset(): void {
    this.messages = [];
    this.pendingToolApproval = null;
    this._isRunning = false;
  }
}
