// router.ts — Slash command dispatcher
// dispatchCommand("/foo bar baz") → Promise<DispatchResult> | null

import { handleHelp, handleTheme, handleLlm, handleVersion, handleAgent, handleExit, handleFont, handleCursor } from "./handlers";
import type { MenuItem } from "../overlay/menu";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  output: string;
  isError: boolean;
}

export interface MenuResult {
  type: "menu";
  items: MenuItem[];
  onSelect: (value: string) => Promise<void>;
  onPreview?: (value: string) => void;
  onCancel?: () => void;
}

export type DispatchResult = CommandResult | MenuResult;

// ─── dispatchCommand ──────────────────────────────────────────────────────────
// Returns null if the input isn't a recognised slash command.
// Caller must check for null before awaiting.

export function dispatchCommand(input: string): Promise<DispatchResult> | null {
  // Must start with /
  if (!input.startsWith("/")) return null;

  // Strip the leading slash, split into tokens
  const [verb, ...rest] = input.slice(1).trim().split(/\s+/);
  const command = (verb ?? "").toLowerCase();

  switch (command) {
    case "help":
      return handleHelp();

    case "version":
      return handleVersion().then((output) => ({ output, isError: false }));

    case "theme":
      return handleTheme(rest);

    case "llm":
      return handleLlm(rest);

    case "agent":
      return handleAgent(rest);

    case "exit":
      return handleExit(rest);

    case "font":
      return handleFont(rest.join(" "));

    case "cursor":
      return handleCursor(rest.join(" "));

    default:
      // Unknown command — surface a helpful error rather than silent null
      return Promise.resolve({
        output: `Unknown command "/${command}". Type /help for a list.`,
        isError: true,
      });
  }
}
