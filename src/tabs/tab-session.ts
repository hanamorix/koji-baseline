// tab-session.ts — Per-tab terminal state

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { DOMGrid, type GridSnapshot, type RenderCell } from "../terminal/dom-grid";
import { MouseReporter } from "../terminal/mouse";
import { SelectionManager } from "../terminal/selection";
import { Autocomplete } from "../terminal/autocomplete";
import { TransitionEffects } from "../animation/effects";
import { TerminalSearch } from "../terminal/search";
import { applyClickableRegions } from "../terminal/clickable";
import { fontManager } from "../fonts/fonts";

export class TabSession {
  readonly id: string;
  readonly grid: DOMGrid;
  readonly mouse: MouseReporter;
  readonly selection: SelectionManager;
  readonly effects: TransitionEffects;
  readonly autocomplete: Autocomplete;
  readonly search: TerminalSearch;
  readonly containerEl: HTMLDivElement;

  private unlisteners: UnlistenFn[] = [];
  private clickableTimer: ReturnType<typeof setTimeout> | null = null;
  private _name = "terminal";
  private _active = false;
  currentInput = "";

  constructor(id: string, parentContainer: HTMLElement) {
    this.id = id;

    this.containerEl = document.createElement("div");
    this.containerEl.className = "tab-panel";
    this.containerEl.style.display = "none";
    this.containerEl.dataset.tabId = id;
    parentContainer.appendChild(this.containerEl);

    // Create a write function that routes to this tab's PTY
    const writeFn = (data: number[]) => this.writePty(data);

    this.grid = new DOMGrid(this.containerEl);
    this.mouse = new MouseReporter(this.grid, writeFn);
    this.selection = new SelectionManager(this.grid.getGridElement(), writeFn);
    this.effects = new TransitionEffects(this.grid.getGridElement());
    this.autocomplete = new Autocomplete(this.grid.getGridElement(), this.grid);
    this.search = new TerminalSearch(this.grid.getGridElement(), this.grid);
  }

  get name(): string { return this._name; }
  set name(v: string) { this._name = v; }
  get active(): boolean { return this._active; }

  async start(): Promise<void> {
    // Apply current font/cursor/config so new tabs match existing ones
    const font = fontManager.getCurrent();
    const size = fontManager.getSize();
    const lig = fontManager.getLigatures();
    this.grid.setFont(font, size, lig);

    // Load cursor style from config
    const cursorStyle = await invoke<string>("load_config", { key: "cursor_style" }).catch(() => "block") || "block";
    if (cursorStyle === "beam" || cursorStyle === "underline" || cursorStyle === "block") {
      this.grid.setCursorStyle(cursorStyle as "block" | "beam" | "underline");
    }

    // Load copy-on-select preference
    const copyOnSelect = await invoke<string>("load_config", { key: "copy_on_select" }).catch(() => "");
    if (copyOnSelect === "false") this.selection.setCopyOnSelect(false);

    const { rows, cols } = this.grid.measureGrid();
    this.grid.resize(rows, cols);

    await invoke("create_session", { tabId: this.id, rows, cols });

    const outputUn = await listen<GridSnapshot>(`terminal-output-${this.id}`, (event) => {
      this.grid.render(event.payload);
      this.mouse.updateMode(event.payload.mouse_mode);
      if (event.payload.title) document.title = event.payload.title;

      if (this.clickableTimer) clearTimeout(this.clickableTimer);
      this.clickableTimer = setTimeout(() => {
        applyClickableRegions(this.grid.getScrollElement(), event.payload.mouse_mode, (data) => this.writePty(data)).catch(() => {});
      }, 200);
    });
    this.unlisteners.push(outputUn);

    const scrollUn = await listen<RenderCell[][]>(`scrollback-append-${this.id}`, (event) => {
      this.grid.appendScrollback(event.payload);
    });
    this.unlisteners.push(scrollUn);

    const bellUn = await listen(`terminal-bell-${this.id}`, () => {
      this.effects.bell();
    });
    this.unlisteners.push(bellUn);
  }

  activate(): void {
    this._active = true;
    this.containerEl.style.display = "";
    const { rows, cols } = this.grid.measureGrid();
    this.grid.resize(rows, cols);
    invoke("resize_session", { tabId: this.id, rows, cols }).catch(console.warn);
  }

  deactivate(): void {
    this._active = false;
    this.containerEl.style.display = "none";
    this.autocomplete.hide();
    if (this.search.isOpen) this.search.close();
  }

  async writePty(data: number[]): Promise<void> {
    await invoke("write_to_session", { tabId: this.id, data });
  }

  async resize(rows: number, cols: number): Promise<void> {
    this.grid.resize(rows, cols);
    await invoke("resize_session", { tabId: this.id, rows, cols });
  }

  async close(): Promise<void> {
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    if (this.clickableTimer) clearTimeout(this.clickableTimer);
    this.grid.destroy();
    this.containerEl.remove();
    await invoke("close_session", { tabId: this.id }).catch(() => {});
  }
}
