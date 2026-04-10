// handlers.ts — Slash command implementations
// Each handler is async, returns { output, isError } or MenuResult. Keep them crisp.

import { invoke } from "@tauri-apps/api/core";
import { THEMES, THEME_NAMES } from "../themes/themes";
import { themeManager } from "../themes/manager";
import { agentPane } from "../agent/pane";
import type { MenuResult } from "./router";

// ─── /help ────────────────────────────────────────────────────────────────────

export async function handleHelp(): Promise<string> {
  const rows = [
    ["/help",                   "Show this command reference"],
    ["/version",                "Print Kōji version string"],
    ["/theme",                  "Open interactive theme picker"],
    ["/theme <name>",           "Switch to named theme directly"],
    ["/llm",                    "Check Ollama connection status"],
    ["/llm connect",            "Alias for status check"],
    ["/llm model <name>",       "Hot-swap the active LLM model"],
    ["/llm models",             "Open interactive model picker"],
    ["/llm pull <name>",        "Pull a model from Ollama registry"],
    ["/llm autorun off",        "Disable agent autorun (safest)"],
    ["/llm autorun safe",       "Autorun read-only tool calls only"],
    ["/llm autorun full",       "Autorun all tool calls (caution!)"],
    ["/llm recommend",          "Show recommended models table"],
    ["/llm provider",           "List configured LLM providers"],
    ["/llm provider <name>",    "Switch active LLM provider"],
    ["/agent",                  "Open agent split-pane"],
    ["/exit",                   "Close agent split-pane"],
    [">> <question>",           "Send a prompt directly to the LLM"],
  ];

  const colW = Math.max(...rows.map((r) => r[0].length)) + 2;
  const border = "─".repeat(colW) + "┬" + "─".repeat(48);

  const lines: string[] = [
    "┌" + border + "┐",
    "│" + " Command".padEnd(colW) + "│" + " Description".padEnd(48) + "│",
    "├" + border + "┤",
  ];

  for (const [cmd, desc] of rows) {
    lines.push("│" + (" " + cmd).padEnd(colW) + "│" + (" " + desc).padEnd(48) + "│");
  }

  lines.push("└" + "─".repeat(colW) + "┴" + "─".repeat(48) + "┘");

  // ── Recommended Models section ─────────────────────────────────────────────
  lines.push("");
  lines.push("Recommended Models:");
  lines.push("─".repeat(colW + 1 + 48));
  const recRows = [
    ["qwen2.5:7b",       "Best all-round, fast, small footprint"],
    ["qwen2.5-coder:7b", "Code tasks, tool use, structured output"],
    ["mistral:7b",       "Strong reasoning, good for prose"],
    ["phi4:14b",         "High quality, needs 12GB+ VRAM"],
    ["llama3.2:3b",      "Ultra-fast, tiny, great for quick hits"],
  ];
  for (const [model, note] of recRows) {
    lines.push("  " + model.padEnd(colW - 1) + note);
  }

  return lines.join("\n");
}

// ─── /theme ───────────────────────────────────────────────────────────────────

export async function handleTheme(args: string[]): Promise<{ output: string; isError: boolean } | MenuResult> {
  // No args → open interactive picker
  if (args.length === 0) {
    const current = themeManager.getCurrentName();
    const originalTheme = current;

    const items = THEME_NAMES.map((name) => {
      const t = THEMES[name];
      return {
        label: t.displayName,
        value: name,
        description: `${t.source}`,
        active: name === current,
      };
    });

    const menuResult: MenuResult = {
      type: "menu",
      items,
      onPreview: (value: string) => {
        // Live preview — apply without persisting (themeManager.apply saves too,
        // but preview calls are transient; cancel will restore)
        themeManager.apply(value).catch(console.warn);
      },
      onCancel: () => {
        // Restore original theme if user bails
        themeManager.apply(originalTheme).catch(console.warn);
      },
      onSelect: async (value: string) => {
        await themeManager.apply(value);
      },
    };

    return menuResult;
  }

  // Named arg → direct switch
  const name = args[0].toLowerCase();
  if (!THEMES[name]) {
    const valid = THEME_NAMES.join(", ");
    return { output: `Unknown theme "${name}". Valid: ${valid}`, isError: true };
  }

  await themeManager.apply(name);
  return { output: `Theme switched → ${THEMES[name].displayName}`, isError: false };
}

// ─── /llm ─────────────────────────────────────────────────────────────────────

export async function handleLlm(args: string[]): Promise<{ output: string; isError: boolean } | MenuResult> {
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

  // models: open interactive picker
  if (sub === "models") {
    try {
      const models = await invoke<string[]>("ollama_list_models");
      if (models.length === 0) {
        return { output: "No models found in Ollama.", isError: false };
      }

      const items = models.map((m) => ({ label: m, value: m }));

      const menuResult: MenuResult = {
        type: "menu",
        items,
        onSelect: async (value: string) => {
          await invoke("switch_model", { model: value });
        },
      };

      return menuResult;
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

  // autorun off|safe|full
  if (sub === "autorun") {
    const level = args[1]?.toLowerCase() ?? "";
    const valid = ["off", "safe", "full"];
    if (!valid.includes(level)) {
      return { output: `Usage: /llm autorun off|safe|full`, isError: true };
    }
    try {
      await invoke("save_config", { key: "autorun", value: level });
      const warning = level === "full"
        ? "\n⚠  full autorun executes ALL tool calls without confirmation."
        : "";
      return { output: `Autorun set → ${level}${warning}`, isError: false };
    } catch (e) {
      return { output: `Failed to save autorun setting: ${e}`, isError: true };
    }
  }

  // recommend: print recommended models table
  if (sub === "recommend") {
    const rows = [
      ["qwen2.5:7b",       "Best all-round, fast, small footprint"],
      ["qwen2.5-coder:7b", "Code tasks, tool use, structured output"],
      ["mistral:7b",       "Strong reasoning, good for prose"],
      ["phi4:14b",         "High quality, needs 12GB+ VRAM"],
      ["llama3.2:3b",      "Ultra-fast, tiny, great for quick hits"],
    ];
    const colW = Math.max(...rows.map((r) => r[0].length)) + 2;
    const border = "─".repeat(colW) + "┬" + "─".repeat(44);
    const lines = [
      "Recommended Models:",
      "┌" + border + "┐",
      "│" + " Model".padEnd(colW) + "│" + " Notes".padEnd(44) + "│",
      "├" + border + "┤",
    ];
    for (const [model, note] of rows) {
      lines.push("│" + (" " + model).padEnd(colW) + "│" + (" " + note).padEnd(44) + "│");
    }
    lines.push("└" + "─".repeat(colW) + "┴" + "─".repeat(44) + "┘");
    lines.push("  Pull with: /llm pull <name>");
    return { output: lines.join("\n"), isError: false };
  }

  // provider / provider <name>: placeholder for Task 5
  if (sub === "provider") {
    const providerName = args[1]?.toLowerCase() ?? "";
    if (!providerName) {
      // List providers — Task 5 will populate this from actual config
      return {
        output: [
          "Configured providers:",
          "  ● ollama  (active)  — http://localhost:11434",
          "",
          "  Use /llm provider <name> to switch.",
          "  Additional providers available after Task 5.",
        ].join("\n"),
        isError: false,
      };
    }
    // Switch provider — placeholder until Task 5 wires the real abstraction
    return {
      output: `Provider switching to "${providerName}" — available in Task 5.`,
      isError: false,
    };
  }

  return { output: `Unknown /llm subcommand "${sub}". Try: connect, models, model <name>, pull <name>, autorun, recommend, provider`, isError: true };
}

// ─── /agent ───────────────────────────────────────────────────────────────────

export async function handleAgent(_args: string[]): Promise<{ output: string; isError: boolean }> {
  if (agentPane.isOpen) {
    return { output: "Agent pane is already open.", isError: false };
  }
  await agentPane.open();
  // Pane is now open — no overlay message needed (UI speaks for itself)
  return { output: "", isError: false };
}

// ─── /exit ────────────────────────────────────────────────────────────────────

export async function handleExit(_args: string[]): Promise<{ output: string; isError: boolean }> {
  if (!agentPane.isOpen) {
    return { output: "Agent pane is not open.", isError: false };
  }
  agentPane.close();
  return { output: "Agent pane closed.", isError: false };
}

// ─── /version ─────────────────────────────────────────────────────────────────

export async function handleVersion(): Promise<string> {
  return "Kōji Baseline v0.3.0";
}
