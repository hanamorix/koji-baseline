// openai-compat.ts — OpenAI-compatible provider (Together.ai, Groq, Fireworks.ai)
// Wraps the Tauri openai_chat_stream command behind the LlmProvider interface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  LlmProvider,
  ChatMessage,
  ToolDefinition,
  StreamChunk,
  ProviderConfig,
} from "./provider";

interface OpenAIChunkEvent {
  chunk_type: "text" | "tool_call" | "done" | "error";
  content?: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_arguments?: string;
}

export class OpenAICompatProvider implements LlmProvider {
  name: string;
  private config: ProviderConfig;
  private model: string;

  constructor(name: string, config: ProviderConfig, model: string) {
    this.name = name;
    this.config = config;
    this.model = model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chatStream(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): AsyncIterable<StreamChunk> {
    const chunks: StreamChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unlisten = await listen<OpenAIChunkEvent>("openai-chunk", (event) => {
      const c = event.payload;
      switch (c.chunk_type) {
        case "text":
          chunks.push({ type: "text", content: c.content ?? "" });
          break;
        case "tool_call":
          chunks.push({
            type: "tool_call",
            tool_call: {
              id: c.tool_call_id ?? "",
              type: "function",
              function: {
                name: c.tool_name ?? "",
                arguments: c.tool_arguments ?? "{}",
              },
            },
          });
          break;
        case "done":
          done = true;
          chunks.push({ type: "done" });
          break;
        case "error":
          done = true;
          chunks.push({ type: "error", error: c.content ?? "Unknown error" });
          break;
      }
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Convert messages to the format Rust expects
    const openaiMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: m.tool_calls?.map((tc) => ({
        id: tc.id,
        call_type: tc.type,
        function: tc.function,
      })),
      tool_call_id: m.tool_call_id,
    }));

    // Convert tool definitions to Rust format
    const rustTools = tools?.map((t) => ({
      tool_type: t.type,
      function: t.function,
    }));

    const queryPromise = invoke("openai_chat_stream", {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey ?? "",
      model: this.model,
      messages: openaiMessages,
      tools: rustTools ?? null,
    }).catch((err) => {
      chunks.push({ type: "error", error: String(err) });
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    try {
      while (!done) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else {
          await new Promise<void>((r) => { resolve = r; });
        }
      }
      while (chunks.length > 0) {
        yield chunks.shift()!;
      }
    } finally {
      unlisten();
      await queryPromise;
    }
  }

  async listModels(): Promise<string[]> {
    return invoke<string[]>("openai_list_models", {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey ?? "",
    });
  }
}
