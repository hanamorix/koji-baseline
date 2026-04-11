// history-db.ts — Persistent command history with metadata
// Stored in ~/.koji-baseline/history.json, loaded on startup, appended per command.

import { invoke } from "@tauri-apps/api/core";

export interface HistoryEntry {
  command: string;
  cwd: string;
  exitCode: number | null;
  timestamp: number;  // ms since epoch
}

class HistoryDb {
  private entries: HistoryEntry[] = [];
  private maxEntries = 5000;
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await invoke<string>("agent_read_file", {
        path: "~/.koji-baseline/history.json",
        startLine: null,
        endLine: null,
      });
      this.entries = JSON.parse(raw);
      this.loaded = true;
    } catch {
      this.entries = [];
      this.loaded = true;
    }
  }

  async addEntry(command: string, cwd: string, exitCode: number | null): Promise<void> {
    if (!command.trim()) return;

    this.entries.push({
      command: command.trim(),
      cwd,
      exitCode,
      timestamp: Date.now(),
    });

    // Trim to max
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Persist
    await this.save();
  }

  private async save(): Promise<void> {
    try {
      await invoke("agent_write_file", {
        path: "~/.koji-baseline/history.json",
        content: JSON.stringify(this.entries),
      });
    } catch {
      // Non-fatal — history is a convenience feature
    }
  }

  /** Search history by prefix match (for ghost-text suggestions) */
  findByPrefix(prefix: string, cwd?: string): HistoryEntry[] {
    const lower = prefix.toLowerCase();
    const matches = this.entries
      .filter((e) => e.command.toLowerCase().startsWith(lower))
      .reverse(); // Most recent first

    // Prefer matches from the same CWD
    if (cwd) {
      const cwdMatches = matches.filter((e) => e.cwd === cwd);
      if (cwdMatches.length > 0) return cwdMatches.slice(0, 10);
    }
    return matches.slice(0, 10);
  }

  /** Search history by substring match (for fuzzy fallback) */
  findBySubstring(query: string): HistoryEntry[] {
    const lower = query.toLowerCase();
    return this.entries
      .filter((e) => e.command.toLowerCase().includes(lower))
      .reverse()
      .slice(0, 20);
  }

  /** Get all entries (for semantic search embedding) */
  getAll(): HistoryEntry[] {
    return this.entries;
  }

  /** Get recent entries (for AI context) */
  getRecent(count: number): HistoryEntry[] {
    return this.entries.slice(-count);
  }
}

export const historyDb = new HistoryDb();
