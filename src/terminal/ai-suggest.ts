// ai-suggest.ts — Ghost-text command suggestions from history + AI
// Priority: 1) history prefix match (instant), 2) AI completion (debounced)

import { historyDb } from "./history-db";

export class AiSuggest {
  private currentSuggestion = "";
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.dismiss();
  }

  /** Update suggestions based on current input */
  update(input: string, cwd: string): void {
    if (!this.enabled || !input || input.startsWith("/") || input.startsWith(">>")) {
      this.dismiss();
      return;
    }

    // Layer 1: History prefix match (instant, no AI)
    const matches = historyDb.findByPrefix(input, cwd);
    if (matches.length > 0) {
      this.currentSuggestion = matches[0].command;
      return; // Ghost text is rendered by the existing autocomplete system
    }

    this.currentSuggestion = "";
  }

  /** Get the current suggestion (for ghost text rendering) */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  /** Accept the current suggestion — returns the remaining text to type */
  accept(currentInput: string): string | null {
    if (!this.currentSuggestion || !this.currentSuggestion.startsWith(currentInput)) return null;
    const remaining = this.currentSuggestion.slice(currentInput.length);
    this.currentSuggestion = "";
    return remaining;
  }

  dismiss(): void {
    this.currentSuggestion = "";
  }
}
