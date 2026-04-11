// error-assist.ts — Automatic AI diagnosis for failed commands
// When a command exits non-zero, sends output to Ollama and shows inline fix.

import { invoke } from "@tauri-apps/api/core";
import type { CommandZone } from "../tabs/tab-session";
import type { DOMGrid } from "../terminal/dom-grid";

interface DiagnosisResult {
  explanation: string;
  fixCommand: string | null;
}

export class ErrorAssist {
  private grid: DOMGrid;
  private scrollEl: HTMLElement;
  private lastDiagTime = 0;
  private activeEls: HTMLElement[] = [];
  private enabled = true;
  private minInterval = 5000; // 5s between diagnoses

  constructor(grid: DOMGrid) {
    this.grid = grid;
    this.scrollEl = grid.getScrollElement();
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }

  /** Check if a completed zone should trigger AI diagnosis */
  async checkZone(
    zone: CommandZone,
    cwd: string,
    writePty: (data: number[]) => Promise<void>,
  ): Promise<void> {
    if (!this.enabled) return;
    if (zone.exit_code === null || zone.exit_code === 0) return;
    if (zone.end_line === null) return;

    // Rate limit
    const now = Date.now();
    if (now - this.lastDiagTime < this.minInterval) return;
    this.lastDiagTime = now;

    // Check if Ollama model is configured
    const model = await invoke<string>("load_config", { key: "activeModel" }).catch(() => "");
    if (!model) return;

    // Extract command and output text
    const commandText = this.extractText(zone.input_line ?? zone.prompt_line, zone.output_line ?? zone.prompt_line);
    const outputText = this.extractText(zone.output_line ?? zone.prompt_line, zone.end_line);

    // Don't send huge outputs
    if (outputText.length > 5000) return;

    // Query Ollama via agent_run_command (simpler than streaming API for short diagnostic queries)
    try {
      const prompt = `You are a terminal error diagnostician. A command failed. Explain why in 1-2 sentences and suggest a fix command if possible. Reply in this format:
EXPLANATION: <your explanation>
FIX: <suggested command or "none">

Command: ${commandText.trim().split("\n")[0]}
Exit code: ${zone.exit_code}
Output:
${outputText.slice(0, 3000)}

Working directory: ${cwd}`;

      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const result = await invoke<string>("agent_run_command", {
        command: `echo '${escapedPrompt}' | ollama run ${model} 2>/dev/null`,
      });

      const diagnosis = this.parseResponse(result);
      if (diagnosis) {
        this.showDiagnosis(zone, diagnosis, writePty);
      }
    } catch {
      // Non-fatal — Ollama might not be running
    }
  }

  private parseResponse(response: string): DiagnosisResult | null {
    if (!response || response.includes("[no output]")) return null;

    // Try to parse structured response
    const explanationMatch = response.match(/EXPLANATION:\s*(.+?)(?=FIX:|$)/s);
    const fixMatch = response.match(/FIX:\s*(.+?)$/s);

    const explanation = explanationMatch?.[1]?.trim() || response.trim().split("\n")[0];
    let fixCommand = fixMatch?.[1]?.trim() || null;
    if (fixCommand === "none" || fixCommand === "None") fixCommand = null;

    if (!explanation) return null;
    return { explanation, fixCommand };
  }

  private showDiagnosis(
    zone: CommandZone,
    diagnosis: DiagnosisResult,
    writePty: (data: number[]) => Promise<void>,
  ): void {
    const lineHeight = this.grid.getFontSize() * 1.3;
    const top = (zone.end_line! + 1) * lineHeight;

    const el = document.createElement("div");
    el.className = "error-assist";
    el.style.top = `${top}px`;

    const text = document.createElement("div");
    text.className = "error-assist-text";
    text.textContent = `💡 ${diagnosis.explanation}`;
    el.appendChild(text);

    if (diagnosis.fixCommand) {
      const fix = document.createElement("div");
      fix.className = "error-assist-fix";
      fix.textContent = `$ ${diagnosis.fixCommand}`;
      el.appendChild(fix);
    }

    const actions = document.createElement("div");
    actions.className = "error-assist-actions";

    if (diagnosis.fixCommand) {
      const runBtn = document.createElement("button");
      runBtn.className = "error-assist-btn primary";
      runBtn.textContent = "Run fix";
      runBtn.addEventListener("click", () => {
        const cmd = diagnosis.fixCommand! + "\r";
        writePty(Array.from(new TextEncoder().encode(cmd))).catch(console.error);
        el.remove();
      });
      actions.appendChild(runBtn);
    }

    const dismissBtn = document.createElement("button");
    dismissBtn.className = "error-assist-btn";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => el.remove());
    actions.appendChild(dismissBtn);

    el.appendChild(actions);
    this.scrollEl.appendChild(el);
    this.activeEls.push(el);
  }

  clear(): void {
    for (const el of this.activeEls) el.remove();
    this.activeEls = [];
  }

  private extractText(startLine: number, endLine: number): string {
    const rows = this.scrollEl.querySelectorAll(".grid-row");
    const lines: string[] = [];
    for (let i = startLine; i <= endLine && i < rows.length; i++) {
      lines.push(rows[i].textContent ?? "");
    }
    return lines.join("\n");
  }
}
