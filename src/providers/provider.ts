// provider.ts — LLM provider interface
// All providers implement this contract. Streaming via AsyncIterable.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface StreamChunk {
  type: "text" | "tool_call" | "done" | "error";
  content?: string;
  tool_call?: ToolCall;
  error?: string;
}

export interface LlmProvider {
  name: string;
  chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamChunk>;
  listModels(): Promise<string[]>;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
}

// ─── Active provider factory ──────────────────────────────────────────────────

import { invoke } from "@tauri-apps/api/core";
import { OllamaProvider } from "./ollama";

/**
 * Read activeProvider from ~/.koji-baseline/config.json and return
 * the matching LlmProvider instance. Defaults to "ollama".
 */
export async function getActiveProvider(): Promise<LlmProvider> {
  const activeProvider = await invoke<string>("load_config", { key: "activeProvider" }).catch(() => "");
  const name = activeProvider || "ollama";

  switch (name) {
    case "ollama":
    default:
      return new OllamaProvider();
  }
}
