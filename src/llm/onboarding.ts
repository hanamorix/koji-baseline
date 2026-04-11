// onboarding.ts — Guided LLM setup triggered by the >> badge
// Walks the user through: Ollama running? → model installed? → ready.

import { invoke } from "@tauri-apps/api/core";
import { overlay } from "../overlay/overlay";
import { openMenu } from "../overlay/menu";
import { updateLlmBadge } from "../dashboard/badge";

const RECOMMENDED_MODELS = [
  { name: "qwen2.5:7b",       desc: "Best all-round — fast, small footprint" },
  { name: "qwen2.5-coder:7b", desc: "Code tasks, tool use, structured output" },
  { name: "mistral:7b",       desc: "Strong reasoning, good for prose" },
  { name: "phi4:14b",         desc: "High quality, needs 12 GB+ VRAM" },
  { name: "llama3.2:3b",      desc: "Ultra-fast, tiny, great for quick hits" },
];

export class LlmOnboarding {
  /**
   * Run the guided setup flow.
   * - Ollama offline  → explain + download link
   * - Online, no model → interactive model picker with auto-pull
   * - Online, model ready → quick confirmation message
   */
  async run(): Promise<void> {
    let status: { model: string; state: string } | null = null;

    try {
      status = await invoke<{ model: string; state: string }>("check_ollama");
    } catch {
      // Ollama is not running
      this.showOfflineMessage();
      return;
    }

    if (status.state !== "ready" || !status.model) {
      // Ollama running but no model configured — show picker
      await this.showModelPicker();
      return;
    }

    // All good
    overlay.showMessage(
      `● Ollama ready  ·  model: ${status.model}\n\nType >> followed by your question, or /agent for the full agent.`,
      false,
    );
    overlay.dismissAfter(4000);
  }

  // ── Ollama offline message ────────────────────────────────────────────────────

  private showOfflineMessage(): void {
    overlay.showMessage(
      [
        "○ Ollama is not running.",
        "",
        "To use the AI agent, you need Ollama — a local LLM runtime.",
        "",
        "  Download: https://ollama.com/download",
        "",
        "  After installing, run:",
        "    ollama serve",
        "",
        "Then click >> again or type /llm connect",
      ].join("\n"),
      true,
    );
  }

  // ── Model picker ──────────────────────────────────────────────────────────────

  private async showModelPicker(): Promise<void> {
    // Try to list existing models first; fall back to recommended list
    let existingModels: string[] = [];
    try {
      existingModels = await invoke<string[]>("ollama_list_models");
    } catch {
      // Registry call failed — use recommended list only
    }

    // Merge: installed first, then recommended models not already present
    const installedSet = new Set(existingModels);
    const allItems = [
      ...existingModels.map((m) => ({ label: `✔ ${m}`, value: m, description: "installed" })),
      ...RECOMMENDED_MODELS
        .filter((r) => !installedSet.has(r.name))
        .map((r) => ({ label: r.name, value: r.name, description: `${r.desc}  [pull]` })),
    ];

    if (allItems.length === 0) {
      overlay.showMessage(
        "No models found. Pull one with:\n  /llm pull <model-name>\n\nExample:\n  /llm pull qwen2.5:7b",
        false,
      );
      return;
    }

    openMenu({
      type: "menu",
      items: allItems,
      onSelect: async (modelName) => {
        if (!installedSet.has(modelName)) {
          overlay.showMessage(`Pulling ${modelName}…\nThis may take a minute.`, false);
          try {
            await invoke("ollama_pull_model", { model: modelName });
          } catch (e) {
            overlay.showMessage(`Pull failed: ${e}`, true);
            return;
          }
        }

        try {
          await invoke("switch_model", { model: modelName });
          await invoke("save_config", { key: "activeModel", value: modelName });

          updateLlmBadge(modelName);

          overlay.showMessage(
            `● Ready!  model: ${modelName}\n\nType >> followed by your question, or /agent for the full agent.`,
            false,
          );
          overlay.dismissAfter(4000);
        } catch (e) {
          overlay.showMessage(`Failed to activate model: ${e}`, true);
          overlay.dismissAfter(5000);
        }
      },
    });
  }
}

/** Singleton — imported by main.ts and wired to the badge click. */
export const llmOnboarding = new LlmOnboarding();
