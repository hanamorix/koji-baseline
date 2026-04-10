// autocomplete.ts — Command input bar with ghost-text autosuggestion
// Shows a visible input line when typing / or >> commands (which don't go to PTY).
// Shows ghost suggestions from slash commands and shell history.

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
  private barEl: HTMLDivElement;
  private prefixEl: HTMLSpanElement;
  private textEl: HTMLSpanElement;
  private ghostEl: HTMLSpanElement;
  private cursorEl: HTMLSpanElement;
  private currentSuggestion = "";
  private shellHistory: string[] = [];
  private barVisible = false;

  constructor(container: HTMLElement) {
    // Build the command input bar
    this.barEl = document.createElement("div");
    this.barEl.className = "command-input-bar";

    this.prefixEl = document.createElement("span");
    this.prefixEl.className = "input-prefix";

    this.textEl = document.createElement("span");
    this.textEl.className = "input-text";

    this.ghostEl = document.createElement("span");
    this.ghostEl.className = "input-ghost";

    this.cursorEl = document.createElement("span");
    this.cursorEl.className = "input-cursor";

    this.barEl.appendChild(this.prefixEl);
    this.barEl.appendChild(this.textEl);
    this.barEl.appendChild(this.cursorEl);
    this.barEl.appendChild(this.ghostEl);

    container.appendChild(this.barEl);
  }

  /** Add a command to shell history (called on Enter for non-slash commands). */
  addToHistory(cmd: string): void {
    const idx = this.shellHistory.indexOf(cmd);
    if (idx >= 0) this.shellHistory.splice(idx, 1);
    this.shellHistory.push(cmd);
    if (this.shellHistory.length > 100) this.shellHistory.shift();
  }

  /** Update display and ghost suggestion based on current input. */
  update(input: string): string {
    if (!input) {
      this.hideBar();
      this.currentSuggestion = "";
      return "";
    }

    // Show the command input bar for slash commands and >> queries
    const isIntercepted = input.startsWith("/") || input.startsWith(">>");
    if (isIntercepted) {
      this.showBar(input);
    } else {
      this.hideBar();
    }

    // Find suggestion
    let match = "";
    if (input.startsWith("/")) {
      const lower = input.toLowerCase();
      match = SLASH_COMMANDS.find((cmd) =>
        cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower
      ) ?? "";
    } else {
      for (let i = this.shellHistory.length - 1; i >= 0; i--) {
        if (this.shellHistory[i].startsWith(input) && this.shellHistory[i] !== input) {
          match = this.shellHistory[i];
          break;
        }
      }
    }

    if (match) {
      this.currentSuggestion = match;
      const completion = match.slice(input.length);
      this.ghostEl.textContent = completion;
    } else {
      this.currentSuggestion = "";
      this.ghostEl.textContent = "";
    }

    return this.currentSuggestion;
  }

  /** Accept the current suggestion. Returns the full command or empty. */
  accept(): string {
    const suggestion = this.currentSuggestion;
    this.currentSuggestion = "";
    return suggestion;
  }

  /** Dismiss everything. */
  hide(): void {
    this.hideBar();
    this.currentSuggestion = "";
    this.ghostEl.textContent = "";
  }

  /** Get current suggestion without accepting. */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  private showBar(input: string): void {
    if (input.startsWith(">>")) {
      this.prefixEl.textContent = ">>";
      this.textEl.textContent = input.slice(2);
    } else if (input.startsWith("/")) {
      this.prefixEl.textContent = "/";
      this.textEl.textContent = input.slice(1);
    }

    if (!this.barVisible) {
      this.barEl.classList.add("active");
      this.barVisible = true;
    }
  }

  private hideBar(): void {
    if (this.barVisible) {
      this.barEl.classList.remove("active");
      this.barVisible = false;
      this.textEl.textContent = "";
      this.ghostEl.textContent = "";
      this.prefixEl.textContent = "";
    }
  }
}
