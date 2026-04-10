// status-bar.ts — Wallace dashboard initialiser
// Wires: era clock, system-stats events → CPU/MEM display elements.
// Listens for "cwd-changed" → updates path, git branch, git status.

import { listen } from "@tauri-apps/api/event";
import { startClock } from "./clock";

interface SystemStats {
  cpu_percent: f32;
  mem_used_gb: f32;
  mem_total_gb: f32;
}

interface CwdInfo {
  path: string;
  git_branch: string | null;
  git_status: string | null;
}

// TypeScript doesn't know f32 — alias it
type f32 = number;

/**
 * Call once from main.ts. Mounts the clock and hooks the system-stats
 * event stream into the three dashboard display elements.
 */
export function initDashboard(): void {
  // ── Clock ────────────────────────────────────────────────────────────────
  const clockEl = document.getElementById("era-clock");
  if (clockEl) startClock(clockEl);

  // ── System stats ─────────────────────────────────────────────────────────
  const cpuEl  = document.getElementById("cpu-value");
  const memEl  = document.getElementById("mem-value");

  listen<SystemStats>("system-stats", (event) => {
    const { cpu_percent, mem_used_gb } = event.payload;

    if (cpuEl)  cpuEl.textContent  = `${Math.round(cpu_percent)}%`;
    if (memEl)  memEl.textContent  = `${mem_used_gb.toFixed(1)}G`;
  }).catch((err) => {
    console.warn("system-stats listener failed:", err);
  });

  // ── CWD + git status ─────────────────────────────────────────────────────
  const cwdPathEl    = document.getElementById("cwd-path");
  const gitBranchEl  = document.getElementById("git-branch");
  const gitStatusEl  = document.getElementById("git-status");

  listen<CwdInfo>("cwd-changed", (event) => {
    const { path, git_branch, git_status } = event.payload;

    if (cwdPathEl)   cwdPathEl.textContent   = path;
    if (gitBranchEl) gitBranchEl.textContent = git_branch ?? "";
    if (gitStatusEl) gitStatusEl.textContent = git_status ?? "";
  }).catch((err) => {
    console.warn("cwd-changed listener failed:", err);
  });
}
