// handlers.ts — Slash command implementations
// Each handler is async, returns { output, isError } or MenuResult. Keep them crisp.

import { invoke } from "@tauri-apps/api/core";
import { THEMES, THEME_NAMES } from "../themes/themes";
import { themeManager } from "../themes/manager";
import { agentPane } from "../agent/pane";
import { fontManager, FONT_OPTIONS } from "../fonts/fonts";
import type { MenuResult, DispatchResult } from "./router";

// ─── /help ────────────────────────────────────────────────────────────────────

export async function handleHelp(): Promise<MenuResult> {
  const items = [
    { label: "/help",             value: "help",      description: "Show this command reference" },
    { label: "/theme",            value: "theme",     description: "Open interactive theme picker" },
    { label: "/font",             value: "font",      description: "Change terminal font" },
    { label: "/cursor",           value: "cursor",    description: "Change cursor style" },
    { label: "/agent",            value: "agent",     description: "Open agent split-pane" },
    { label: "/exit",             value: "exit",      description: "Close agent split-pane" },
    { label: "/version",          value: "version",   description: "Print version" },
    { label: "/llm autorun",      value: "autorun",   description: "Set agent tool approval level" },
    { label: "/llm recommend",    value: "recommend", description: "Show recommended models" },
    { label: "/llm models",       value: "models",    description: "Open interactive model picker" },
    { label: "/llm model <name>", value: "model",     description: "Hot-swap the active LLM model" },
    { label: "/llm pull <name>",  value: "pull",      description: "Pull a model from Ollama registry" },
    { label: ">> question",       value: "query",     description: "Ask the LLM inline" },
  ];

  return {
    type: "menu" as const,
    items,
    onSelect: async (value: string) => {
      // For actionable commands, dispatch them; for informational, show their description
      const result = await (async () => {
        switch (value) {
          case "theme":    return handleTheme([]);
          case "font":     return handleFont("");
          case "cursor":   return handleCursor("");
          case "agent":    return handleAgent([]);
          case "exit":     return handleExit([]);
          case "version":  return handleVersion().then((o) => ({ output: o, isError: false }));
          case "autorun":  return { output: "Usage: /llm autorun off|safe|full", isError: false };
          case "recommend": return handleLlm(["recommend"]);
          case "models":   return handleLlm(["models"]);
          case "model":    return { output: "Usage: /llm model <name>", isError: false };
          case "pull":     return { output: "Usage: /llm pull <name>", isError: false };
          case "query":    return { output: "Type >> followed by your question and press Enter.", isError: false };
          default:         return { output: "Type /help to see this menu again.", isError: false };
        }
      })();

      // Import overlay lazily to avoid circular deps
      const { openMenu: _openMenu } = await import("../overlay/menu");
      const { overlay: _overlay } = await import("../overlay/overlay");

      if (result && "type" in result && (result as MenuResult).type === "menu") {
        _openMenu(result as MenuResult);
      } else if (result) {
        const cmd = result as { output: string; isError: boolean };
        _overlay.showMessage(cmd.output, cmd.isError);
      }
    },
  };
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

  // no-arg: hint about the guided onboarding flow
  if (sub === "") {
    return {
      output: "Click the >> badge in the top bar to set up or check the LLM connection.",
      isError: false,
    };
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
          await invoke("save_config", { key: "activeModel", value });
          const modelEl = document.getElementById("llm-model");
          const dotEl = document.getElementById("llm-dot");
          if (modelEl) modelEl.textContent = value;
          if (dotEl) dotEl.style.background = "#cc7a00";
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
      await invoke("save_config", { key: "activeModel", value: modelName });
      const modelEl = document.getElementById("llm-model");
      const dotEl = document.getElementById("llm-dot");
      if (modelEl) modelEl.textContent = modelName;
      if (dotEl) dotEl.style.background = "#cc7a00";
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

  return { output: `Unknown /llm subcommand "${sub}". Try: models, model <name>, pull <name>, autorun, recommend`, isError: true };
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
  return "Kōji Baseline v0.5.0";
}

// ─── /font ────────────────────────────────────────────────────────────────────

export function handleFont(args: string): Promise<DispatchResult> {
  if (!args || args.trim() === "") {
    // No args → interactive font picker
    const result: MenuResult = {
      type: "menu",
      items: FONT_OPTIONS.map((f) => ({
        label: f.name,
        value: f.name,
        description: f.description,
        active: f.family === fontManager.getCurrent(),
      })),
      onSelect: async (value: string) => {
        const ok = await fontManager.apply(value);
        if (!ok) {
          const { overlay } = await import("../overlay/overlay");
          overlay.showMessage(`Unknown font: ${value}`, true);
        }
      },
      onPreview: (value: string) => {
        const option = FONT_OPTIONS.find((f) => f.name === value);
        if (option) {
          fontManager.apply(option.name).catch(console.warn);
        }
      },
      onCancel: () => {
        fontManager.loadSaved().catch(console.warn);
      },
    };
    return Promise.resolve(result);
  }

  // Named font: /font Iosevka
  const option = FONT_OPTIONS.find(
    (f) => f.name.toLowerCase() === args.trim().toLowerCase()
  );
  if (option) {
    return fontManager.apply(option.name).then(() => ({
      output: `Font: ${option.name}`,
      isError: false,
    }));
  }

  return Promise.resolve({
    output: `Unknown font. Available: ${FONT_OPTIONS.map((f) => f.name).join(", ")}`,
    isError: true,
  });
}

// ─── /cursor ──────────────────────────────────────────────────────────────────

const CURSOR_STYLES = [
  { name: "block",     description: "Solid rectangle — classic terminal" },
  { name: "beam",      description: "Thin vertical line — modern/IDE feel" },
  { name: "underline", description: "Horizontal line under character — minimal" },
];

export async function handleCursor(args: string): Promise<DispatchResult> {
  if (!args) {
    const currentStyle = await invoke<string>("load_config", { key: "cursor_style" }).catch(() => "block") || "block";
    const result: MenuResult = {
      type: "menu",
      items: CURSOR_STYLES.map((s) => ({
        label: s.name,
        value: s.name,
        description: s.description,
        active: s.name === currentStyle,
      })),
      onSelect: async (value: string) => {
        await invoke("save_config", { key: "cursor_style", value });
        const { tabManager } = await import("../main");
        const tab = tabManager.getActive();
        if (tab) tab.grid.setCursorStyle(value as "block" | "beam" | "underline");
      },
      onPreview: (value: string) => {
        import("../main").then(({ tabManager }) => {
          const tab = tabManager.getActive();
          if (tab) tab.grid.setCursorStyle(value as "block" | "beam" | "underline");
        }).catch(() => {});
      },
      onCancel: () => {
        // Restore saved cursor style
        invoke("load_config", { key: "cursor_style" }).then((saved: unknown) => {
          const style = (saved as string) || "block";
          import("../main").then(({ tabManager }) => {
            const tab = tabManager.getActive();
            if (tab) tab.grid.setCursorStyle(style as "block" | "beam" | "underline");
          }).catch(() => {});
        }).catch(() => {});
      },
    };
    return result;
  }

  const style = args.toLowerCase();
  if (["block", "beam", "underline"].includes(style)) {
    await invoke("save_config", { key: "cursor_style", value: style });
    const { tabManager } = await import("../main");
    const tab = tabManager.getActive();
    if (tab) tab.grid.setCursorStyle(style as "block" | "beam" | "underline");
    return { output: `Cursor: ${style}`, isError: false };
  }

  return { output: "Usage: /cursor block|beam|underline", isError: true };
}
