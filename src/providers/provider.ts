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
import { OpenAICompatProvider } from "./openai-compat";

// Known OpenAI-compatible cloud providers and their base URLs
const CLOUD_PROVIDERS: Record<string, string> = {
  together: "https://api.together.xyz/v1",
  groq: "https://api.groq.com/openai/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
};

/**
 * Read activeProvider from ~/.koji-baseline/config.json and return
 * the matching LlmProvider instance. Defaults to "ollama".
 *
 * For cloud providers (together, groq, fireworks), reads api_key and model
 * from config. For custom OpenAI-compatible endpoints, reads base_url too.
 */
export async function getActiveProvider(): Promise<LlmProvider> {
  const activeProvider = await invoke<string>("load_config", { key: "activeProvider" }).catch(() => "");
  const name = activeProvider || "ollama";

  if (name === "ollama") {
    return new OllamaProvider();
  }

  // Built-in cloud providers
  if (name in CLOUD_PROVIDERS) {
    const apiKey = await invoke<string>("load_config", { key: `${name}_api_key` }).catch(() => "");
    const model = await invoke<string>("load_config", { key: `${name}_model` }).catch(() => "");
    return new OpenAICompatProvider(name, { baseUrl: CLOUD_PROVIDERS[name], apiKey }, model);
  }

  // Custom OpenAI-compatible endpoint stored as "openai-compat"
  if (name === "openai-compat") {
    const baseUrl = await invoke<string>("load_config", { key: "openai_compat_base_url" }).catch(() => "");
    const apiKey = await invoke<string>("load_config", { key: "openai_compat_api_key" }).catch(() => "");
    const model = await invoke<string>("load_config", { key: "openai_compat_model" }).catch(() => "");
    return new OpenAICompatProvider("openai-compat", { baseUrl, apiKey }, model);
  }

  // Default fallback
  return new OllamaProvider();
}
