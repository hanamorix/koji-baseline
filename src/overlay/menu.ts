// menu.ts — Interactive arrow-key menu component
// Renders inside the DOM overlay. Captures arrow keys, Enter, Escape, and filter typing.

import { overlay } from "./overlay";

export interface MenuItem {
  label: string;
  value: string;
  description?: string;
  active?: boolean;
}

export interface MenuResult {
  type: "menu";
  items: MenuItem[];
  onSelect: (value: string) => Promise<void>;
  onPreview?: (value: string) => void;
  onCancel?: () => void;
}

export class InteractiveMenu {
  private items: MenuItem[];
  private filteredItems: MenuItem[];
  private highlightIndex = 0;
  private filterText = "";
  private element: HTMLElement;
  private listElement: HTMLElement;
  private filterInput: HTMLInputElement;
  private onSelect: (value: string) => Promise<void>;
  private onPreview?: (value: string) => void;
  private onCancel?: () => void;
  private keyHandler: (e: KeyboardEvent) => void;
  private _isOpen = false;

  constructor(result: MenuResult) {
    this.items = result.items;
    this.filteredItems = [...this.items];
    this.onSelect = result.onSelect;
    this.onPreview = result.onPreview;
    this.onCancel = result.onCancel;

    // Find initial highlight — first active item, or index 0
    const activeIdx = this.items.findIndex((i) => i.active);
    this.highlightIndex = activeIdx >= 0 ? activeIdx : 0;

    // Build DOM
    this.element = document.createElement("div");
    this.element.className = "overlay-menu";

    // Filter input row
    const filterRow = document.createElement("div");
    filterRow.className = "menu-filter";
    this.filterInput = document.createElement("input");
    this.filterInput.type = "text";
    this.filterInput.placeholder = "type to filter...";
    filterRow.appendChild(this.filterInput);
    this.element.appendChild(filterRow);

    // List container
    this.listElement = document.createElement("div");
    this.element.appendChild(this.listElement);

    // Render initial list
    this.renderList();

    // Key handler — bound so we can remove it later
    this.keyHandler = (e: KeyboardEvent) => this.handleKey(e);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Mount the menu into the overlay and start capturing keys. */
  open(): void {
    overlay.mount(this.element);
    this._isOpen = true;

    // Capture keys at the window level, before main.ts keydown handler
    window.addEventListener("keydown", this.keyHandler, true);

    // Focus filter input
    setTimeout(() => this.filterInput.focus(), 0);

    // Fire initial preview
    if (this.onPreview && this.filteredItems.length > 0) {
      this.onPreview(this.filteredItems[this.highlightIndex].value);
    }
  }

  /** Close the menu, remove key listener. */
  close(): void {
    this._isOpen = false;
    window.removeEventListener("keydown", this.keyHandler, true);
    overlay.dismiss();
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this._isOpen) return;

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        e.stopPropagation();
        this.moveHighlight(-1);
        break;

      case "ArrowDown":
        e.preventDefault();
        e.stopPropagation();
        this.moveHighlight(1);
        break;

      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        if (this.filteredItems.length > 0) {
          const selected = this.filteredItems[this.highlightIndex];
          this.close();
          this.onSelect(selected.value).catch(console.error);
        }
        break;

      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        if (this.onCancel) this.onCancel();
        this.close();
        break;

      default:
        // Let typing flow into filter input — it's focused
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          // The input handles it naturally; re-filter on next tick
          setTimeout(() => this.applyFilter(), 0);
        } else if (e.key === "Backspace") {
          setTimeout(() => this.applyFilter(), 0);
        }
        break;
    }
  }

  private applyFilter(): void {
    this.filterText = this.filterInput.value.toLowerCase();
    this.filteredItems = this.items.filter(
      (item) =>
        item.label.toLowerCase().includes(this.filterText) ||
        (item.description?.toLowerCase().includes(this.filterText) ?? false)
    );
    this.highlightIndex = Math.min(this.highlightIndex, Math.max(0, this.filteredItems.length - 1));
    this.renderList();
  }

  private moveHighlight(delta: number): void {
    if (this.filteredItems.length === 0) return;
    this.highlightIndex =
      (this.highlightIndex + delta + this.filteredItems.length) % this.filteredItems.length;
    this.renderList();

    if (this.onPreview) {
      this.onPreview(this.filteredItems[this.highlightIndex].value);
    }
  }

  private renderList(): void {
    this.listElement.innerHTML = "";
    for (let i = 0; i < this.filteredItems.length; i++) {
      const item = this.filteredItems[i];
      const row = document.createElement("div");
      row.className = "menu-item";
      if (i === this.highlightIndex) row.classList.add("highlighted");
      if (item.active) row.classList.add("active-marker");

      const label = document.createElement("span");
      label.className = "menu-label";
      label.textContent = item.label;
      row.appendChild(label);

      if (item.description) {
        const desc = document.createElement("span");
        desc.className = "menu-desc";
        desc.textContent = item.description;
        row.appendChild(desc);
      }

      row.addEventListener("click", () => {
        this.close();
        this.onSelect(item.value).catch(console.error);
      });

      this.listElement.appendChild(row);
    }

    // Scroll highlighted item into view
    const highlighted = this.listElement.querySelector(".highlighted");
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }
}

/** Active menu instance — only one can be open at a time. */
let activeMenu: InteractiveMenu | null = null;

/** Open a menu from a MenuResult. Closes any previous menu. */
export function openMenu(result: MenuResult): void {
  if (activeMenu?.isOpen) activeMenu.close();
  activeMenu = new InteractiveMenu(result);
  activeMenu.open();
}

/** Check if a menu is currently open (for key interception in main.ts). */
export function isMenuOpen(): boolean {
  return activeMenu?.isOpen ?? false;
}
