// context.ts — Command history tracker for LLM context injection
// Keeps a rolling window of recent terminal interactions.

interface HistoryEntry {
  command: string;
  output?: string;
}

const MAX_ENTRIES = 5;
const MAX_OUTPUT_CHARS = 2000;

export class CommandHistory {
  private entries: HistoryEntry[] = [];

  /** Record a submitted shell command. */
  addCommand(cmd: string): void {
    this.entries.push({ command: cmd });
    // Trim oldest if we exceed the cap
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  /** Pair output with the most-recently added command. */
  addOutput(output: string): void {
    const last = this.entries[this.entries.length - 1];
    if (!last) return;
    // Clamp to keep context tokens sane
    last.output = output.slice(0, MAX_OUTPUT_CHARS);
  }

  /** Returns context strings formatted as "$ cmd\noutput" for each entry. */
  getContext(): string[] {
    return this.entries.map((e) => {
      const base = `$ ${e.command}`;
      return e.output ? `${base}\n${e.output}` : base;
    });
  }
}

// Singleton — imported wherever context is needed
export const commandHistory = new CommandHistory();
