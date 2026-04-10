// ollama.ts — Ollama provider implementation
// Wraps the existing Tauri IPC commands behind the LlmProvider interface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  LlmProvider,
  ChatMessage,
  ToolDefinition,
  StreamChunk,
} from "./provider";

interface LlmChunk {
  content: string;
  done: boolean;
}

export class OllamaProvider implements LlmProvider {
  name = "ollama";

  async *chatStream(
    messages: ChatMessage[],
    _tools?: ToolDefinition[],
  ): AsyncIterable<StreamChunk> {
    // Convert messages to the format Rust expects (role + content only)
    const ollamaMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Promise queue — listener pushes, iterator pulls
    const chunks: StreamChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const unlisten = await listen<LlmChunk>("llm-chunk", (event) => {
      const chunk = event.payload;
      if (chunk.content) {
        chunks.push({ type: "text", content: chunk.content });
      }
      if (chunk.done) {
        done = true;
        chunks.push({ type: "done" });
      }
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Fire the query against the existing Rust command.
    // llm_query takes (prompt, context[]) — last message is the prompt,
    // everything before it is context.
    const lastMsg = ollamaMessages[ollamaMessages.length - 1];
    const contextMsgs = ollamaMessages.slice(0, -1).map((m) => m.content);

    const queryPromise = invoke("llm_query", {
      prompt: lastMsg?.content ?? "",
      context: contextMsgs,
    }).catch((err: unknown) => {
      chunks.push({ type: "error", error: String(err) });
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    // Yield chunks as they arrive, waiting when the queue is empty
    try {
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      unlisten();
      await queryPromise;
    }
  }

  async listModels(): Promise<string[]> {
    return invoke<string[]>("ollama_list_models");
  }
}
