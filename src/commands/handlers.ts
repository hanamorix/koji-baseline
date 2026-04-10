// handlers.ts — Slash command implementations
// Each handler is async, returns { output, isError }. Keep them crisp.

import { invoke } from "@tauri-apps/api/core";
import { THEMES, THEME_NAMES } from "../themes/themes";
import { themeManager } from "../themes/manager";

// ─── /help ────────────────────────────────────────────────────────────────────

export async function handleHelp(): Promise<string> {
  const rows = [
    ["/help",              "Show this command reference"],
    ["/version",          "Print Kōji version string"],
    ["/theme",            "List all available themes"],
    ["/theme <name>",     "Switch to named theme"],
    ["/llm",              "Check Ollama connection status"],
    ["/llm connect",      "Alias for status check"],
    ["/llm model <name>", "Hot-swap the active LLM model"],
    ["/llm models",       "List all models available in Ollama"],
    ["/llm pull <name>",  "Pull a model from Ollama registry"],
    [">> <question>",     "Send a prompt directly to the LLM"],
  ];

  const colW = Math.max(...rows.map((r) => r[0].length)) + 2;
  const border = "─".repeat(colW) + "┬" + "─".repeat(44);

  const lines: string[] = [
    "┌" + border + "┐",
    "│" + " Command".padEnd(colW) + "│" + " Description".padEnd(44) + "│",
    "├" + border + "┤",
  ];

  for (const [cmd, desc] of rows) {
    lines.push("│" + (" " + cmd).padEnd(colW) + "│" + (" " + desc).padEnd(44) + "│");
  }

  lines.push("└" + "─".repeat(colW) + "┴" + "─".repeat(44) + "┘");
  return lines.join("\n");
}

// ─── /theme ───────────────────────────────────────────────────────────────────

export async function handleTheme(args: string[]): Promise<{ output: string; isError: boolean }> {
  if (args.length === 0) {
    // List all themes, mark current
    const current = themeManager.getCurrentName();
    const lines = THEME_NAMES.map((name) => {
      const t = THEMES[name];
      const marker = name === current ? "▶ " : "  ";
      return `${marker}${name.padEnd(12)} ${t.displayName} — ${t.source}`;
    });
    return { output: "Available themes:\n" + lines.join("\n"), isError: false };
  }

  const name = args[0].toLowerCase();
  if (!THEMES[name]) {
    const valid = THEME_NAMES.join(", ");
    return { output: `Unknown theme "${name}". Valid: ${valid}`, isError: true };
  }

  await themeManager.apply(name);
  return { output: `Theme switched → ${THEMES[name].displayName}`, isError: false };
}

// ─── /llm ─────────────────────────────────────────────────────────────────────

export async function handleLlm(args: string[]): Promise<{ output: string; isError: boolean }> {
  const sub = args[0]?.toLowerCase() ?? "";

  // connect / no-arg: status check
  if (sub === "" || sub === "connect") {
    try {
      const status = await invoke<{ model: string; state: string }>("check_ollama");
      const icon = status.state === "ready" ? "●" : "○";
      return {
        output: `${icon} Ollama ${status.state}  model: ${status.model}`,
        isError: status.state !== "ready",
      };
    } catch {
      return { output: "○ Ollama offline — is it running?", isError: true };
    }
  }

  // models: list available
  if (sub === "models") {
    try {
      const models = await invoke<string[]>("ollama_list_models");
      if (models.length === 0) {
        return { output: "No models found in Ollama.", isError: false };
      }
      return { output: "Available models:\n" + models.map((m) => "  " + m).join("\n"), isError: false };
    } catch (e) {
      return { output: `Failed to list models: ${e}`, isError: true };
    }
  }

  // model <name>: switch active model
  if (sub === "model") {
    const modelName = args[1];
    if (!modelName) {
      return { output: "Usage: /llm model <name>", isError: true };
    }
    try {
      await invoke("switch_model", { model: modelName });
      return { output: `Active model → ${modelName}`, isError: false };
    } catch (e) {
      return { output: `Failed to switch model: ${e}`, isError: true };
    }
  }

  // pull <name>: pull from registry
  if (sub === "pull") {
    const modelName = args[1];
    if (!modelName) {
      return { output: "Usage: /llm pull <name>", isError: true };
    }
    try {
      await invoke("ollama_pull_model", { model: modelName });
      return { output: `Pulled ${modelName} successfully.`, isError: false };
    } catch (e) {
      return { output: `Pull failed: ${e}`, isError: true };
    }
  }

  return { output: `Unknown /llm subcommand "${sub}". Try: connect, models, model <name>, pull <name>`, isError: true };
}

// ─── /version ─────────────────────────────────────────────────────────────────

export async function handleVersion(): Promise<string> {
  return "Kōji Baseline v0.2.0";
}
