// panel.ts — LLM frontend bridge
// Routes >> queries to Ollama, accumulates streamed tokens, updates the dashboard.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { updateLlmBadge } from "../dashboard/badge";
import { commandHistory } from "./context";

// ─── Payload shapes (must mirror Rust structs) ─────────────────────────────────

interface LlmChunk {
  content: string;
  done: boolean;
}

interface OllamaStatus {
  model: string;
  state: "ready" | "generating" | "offline";
}

type ResponseCallback = (text: string, done: boolean) => void;

// ─── LlmPanel ─────────────────────────────────────────────────────────────────

export class LlmPanel {
  private accumulated = "";
  private callbacks: ResponseCallback[] = [];

  constructor() {
    this.listenChunks();
    this.listenStatus();
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  /** Register a callback that fires on every streaming token batch. */
  onResponseUpdate(cb: ResponseCallback): void {
    this.callbacks.push(cb);
  }

  /**
   * Handle a user's >> query string.
   * Special commands:
   *   >> /model <name>  — switch active model
   *   >> /models        — print help
   * Everything else → Ollama chat.
   */
  async query(raw: string): Promise<void> {
    const prompt = raw.replace(/^>>\s*/, "").trim();

    // ── Built-in slash commands ─────────────────────────────────────────────
    if (prompt.startsWith("/model ")) {
      const name = prompt.slice("/model ".length).trim();
      if (!name) {
        this.fire("[llm] Usage: >> /model <model-name>\n", true);
        return;
      }
      try {
        await invoke("switch_model", { model: name });
        await invoke("save_config", { key: "activeModel", value: name });
        updateLlmBadge(name);
        this.fire(`[llm] Switched to model: ${name}\n`, true);
      } catch (err) {
        this.fire(`[llm] switch_model failed: ${err}\n`, true);
      }
      return;
    }

    if (prompt === "/models") {
      this.fire(
        "[llm] Commands:\n" +
        "  >> /model <name>   — switch active model\n" +
        "  >> /models         — show this help\n" +
        "  >> <anything else> — send to Ollama\n",
        true,
      );
      return;
    }

    // ── Stream query to Ollama ──────────────────────────────────────────────
    this.accumulated = "";
    const context = commandHistory.getContext();

    try {
      await invoke("llm_query", { prompt, context });
    } catch (err) {
      this.fire(`[llm] Query failed: ${err}\n`, true);
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private listenChunks(): void {
    listen<LlmChunk>("llm-chunk", (event) => {
      const { content, done } = event.payload;
      this.accumulated += content;
      this.fire(this.accumulated, done);
      if (done) this.accumulated = "";
    }).catch((err) => {
      console.warn("llm-chunk listener failed:", err);
    });
  }

  private listenStatus(): void {
    listen<OllamaStatus>("llm-status", (event) => {
      const { model, state } = event.payload;
      this.updateDashboard(model, state);
    }).catch((err) => {
      console.warn("llm-status listener failed:", err);
    });
  }

  private fire(text: string, done: boolean): void {
    for (const cb of this.callbacks) {
      cb(text, done);
    }
  }

  private updateDashboard(model: string, state: OllamaStatus["state"]): void {
    const root = getComputedStyle(document.documentElement);
    const modelEl = document.getElementById("llm-model");
    const dotEl = document.getElementById("llm-dot");

    if (modelEl) modelEl.textContent = model;

    if (dotEl) {
      dotEl.className = "llm-dot";
      if (state === "ready") {
        dotEl.style.background = root.getPropertyValue("--koji-warm").trim();
      } else if (state === "generating") {
        dotEl.style.background = root.getPropertyValue("--koji-bright").trim();
      } else {
        dotEl.style.background = root.getPropertyValue("--koji-deep").trim();
      }
    }
  }
}
