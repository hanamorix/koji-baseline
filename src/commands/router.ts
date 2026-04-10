// router.ts — Slash command dispatcher
// dispatchCommand("/foo bar baz") → Promise<CommandResult> | null

import { handleHelp, handleTheme, handleLlm, handleVersion } from "./handlers";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CommandResult {
  output: string;
  isError: boolean;
}

// ─── dispatchCommand ──────────────────────────────────────────────────────────
// Returns null if the input isn't a recognised slash command.
// Caller must check for null before awaiting.

export function dispatchCommand(input: string): Promise<CommandResult> | null {
  // Must start with /
  if (!input.startsWith("/")) return null;

  // Strip the leading slash, split into tokens
  const [verb, ...rest] = input.slice(1).trim().split(/\s+/);
  const command = (verb ?? "").toLowerCase();

  switch (command) {
    case "help":
      return handleHelp().then((output) => ({ output, isError: false }));

    case "version":
      return handleVersion().then((output) => ({ output, isError: false }));

    case "theme":
      return handleTheme(rest);

    case "llm":
      return handleLlm(rest);

    default:
      // Unknown command — surface a helpful error rather than silent null
      return Promise.resolve({
        output: `Unknown command "/${command}". Type /help for a list.`,
        isError: true,
      });
  }
}
