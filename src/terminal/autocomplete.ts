// autocomplete.ts — Ghost-text autosuggestion for slash commands and shell history

const SLASH_COMMANDS = [
  "/help",
  "/version",
  "/theme",
  "/font",
  "/llm",
  "/llm models",
  "/llm recommend",
  "/llm autorun off",
  "/llm autorun safe",
  "/llm autorun full",
  "/agent",
  "/exit",
];

export class Autocomplete {
  private ghostEl: HTMLDivElement;
  private currentSuggestion = "";
  private shellHistory: string[] = [];
  private visible = false;

  constructor(container: HTMLElement) {
    this.ghostEl = document.createElement("div");
    this.ghostEl.className = "autocomplete-ghost";
    container.appendChild(this.ghostEl);
  }

  /** Add a command to shell history (called on Enter for non-slash commands). */
  addToHistory(cmd: string): void {
    // Deduplicate: remove existing occurrence, push to end
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    // Cap at 100 entries
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Update the ghost suggestion based on current input. Returns the full suggestion or empty. */
  update(input: string): string {
    if (!input) {
      this.hide();
      return "";
    }

    let match = "";

    if (input.startsWith("/")) {
      // Match against slash commands (case-insensitive prefix)
      const lower = input.toLowerCase();
      match = SLASH_COMMANDS.find((cmd) => cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) ?? "";
    } else {
      // Match against shell history (most recent first, prefix match)
      for (let i = this.shellHistory.length - 1; i >= 0; i--) {
        if (this.shellHistory[i].startsWith(input) && this.shellHistory[i] !== input) {
          match = this.shellHistory[i];
          break;
        }
      }
    }

    if (match) {
      // Show only the completion portion (what the user hasn't typed yet)
      const completion = match.slice(input.length);
      this.currentSuggestion = match;
      this.ghostEl.textContent = input + completion;
      // Style: show the typed part as invisible (same width spacer), completion as dim
      this.ghostEl.innerHTML =
        `<span class="ghost-typed">${escapeHTML(input)}</span><span class="ghost-completion">${escapeHTML(completion)}</span>`;
      this.show();
    } else {
      this.currentSuggestion = "";
      this.hide();
    }

    return this.currentSuggestion;
  }

  /** Accept the current suggestion. Returns the full command or empty if no suggestion. */
  accept(): string {
    const suggestion = this.currentSuggestion;
    this.hide();
    this.currentSuggestion = "";
    return suggestion;
  }

  /** Dismiss the ghost text. */
  hide(): void {
    if (this.visible) {
      this.ghostEl.style.display = "none";
      this.visible = false;
    }
    this.currentSuggestion = "";
  }

  /** Get current suggestion without accepting. */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  private show(): void {
    if (!this.visible) {
      this.ghostEl.style.display = "";
      this.visible = true;
    }
  }
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
