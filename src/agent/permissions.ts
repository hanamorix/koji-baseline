// permissions.ts — Tool autorun level gating
// Controls which tools need user approval before execution.

import { invoke } from "@tauri-apps/api/core";

export type AutorunLevel = "off" | "safe" | "full";

// Read-only / side-effect-free tools that are safe to autorun
const SAFE_TOOLS = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "search_filenames",
  "git_status",
  "git_diff",
  "fetch_url",
]);

/**
 * Returns true if the tool requires explicit user approval before running.
 *
 * - "off"  → everything needs approval
 * - "safe" → read-only tools run automatically; write/exec tools need approval
 * - "full" → everything runs automatically (no approvals)
 */
export function needsApproval(toolName: string, level: AutorunLevel): boolean {
  if (level === "full") return false;
  if (level === "safe" && SAFE_TOOLS.has(toolName)) return false;
  return true; // "off" always needs approval, and non-safe tools under "safe"
}

/** Get the current autorun level from config. */
export async function getAutorunLevel(): Promise<AutorunLevel> {
  const level = await invoke<string>("load_config", { key: "autorun" }).catch(() => "off");
  if (level === "safe" || level === "full") return level;
  return "off";
}

/** Check if a tool call should auto-approve based on the current autorun level. */
export function shouldAutoApprove(toolName: string, level: AutorunLevel): boolean {
  return !needsApproval(toolName, level);
}

/** Check if a tool is read-only (safe). */
export function isToolSafe(toolName: string): boolean {
  return SAFE_TOOLS.has(toolName);
}
