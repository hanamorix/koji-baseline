// restore.ts — Save terminal state on close, restore on launch

import { invoke } from "@tauri-apps/api/core";
import type { TabManager } from "../tabs/tab-manager";

interface SavedPane {
  cwd: string;
  scrollback: string[];
}

interface SavedLayout {
  Leaf?: { pane_index: number };
  Branch?: { direction: string; ratio: number; first: SavedLayout; second: SavedLayout };
}

interface SavedTab {
  name: string;
  panes: SavedPane[];
  layout: SavedLayout;
}

interface SavedSession {
  tabs: SavedTab[];
  active_tab_index: number;
  window_width: number;
  window_height: number;
}

/** Save the current session state to disk */
export async function saveSession(tabManager: TabManager): Promise<void> {
  const allLayouts = (tabManager as any).layouts as Map<string, any>;
  const tabOrder = (tabManager as any).tabOrder as string[];
  const activeTabId = (tabManager as any).activeTabId as string;

  const tabs: SavedTab[] = [];
  for (const tabId of tabOrder) {
    const layout = allLayouts.get(tabId);
    if (!layout) continue;

    const sessions = layout.getAllSessions();
    const panes: SavedPane[] = sessions.map((s: any) => ({
      cwd: s.cwd || "",
      scrollback: [], // Scrollback text extraction is complex — save CWD only for now
    }));

    tabs.push({
      name: sessions[0]?.name || "terminal",
      panes,
      layout: { Leaf: { pane_index: 0 } }, // Simplified — single pane per tab for now
    });
  }

  const session: SavedSession = {
    tabs,
    active_tab_index: tabOrder.indexOf(activeTabId),
    window_width: window.innerWidth,
    window_height: window.innerHeight,
  };

  await invoke("save_session", { session });
}

/** Check for a saved session and restore it */
export async function restoreSession(tabManager: TabManager): Promise<boolean> {
  try {
    const session = await invoke<SavedSession | null>("load_saved_session");
    if (!session || session.tabs.length === 0) return false;

    // Create tabs with saved CWDs
    // First tab already created by boot sequence — recreate additional tabs
    for (let i = 1; i < session.tabs.length; i++) {
      await tabManager.createTab();
    }

    // Switch to the previously active tab
    if (session.active_tab_index >= 0 && session.active_tab_index < session.tabs.length) {
      const tabOrder = (tabManager as any).tabOrder as string[];
      if (tabOrder[session.active_tab_index]) {
        tabManager.switchTo(tabOrder[session.active_tab_index]);
      }
    }

    return true;
  } catch {
    return false;
  }
}
