// keybindings.ts — Configurable keybinding system
// Parses "cmd+shift+p" format, matches against KeyboardEvent, dispatches actions.

export interface KeyCombo {
  key: string;
  cmd: boolean;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export type ActionHandler = () => void | Promise<void>;

export function parseKeyCombo(combo: string): KeyCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    key: normalizeKey(key),
    cmd: parts.includes("cmd") || parts.includes("meta"),
    shift: parts.includes("shift"),
    ctrl: parts.includes("ctrl"),
    alt: parts.includes("alt") || parts.includes("option"),
  };
}

function normalizeKey(key: string): string {
  const map: Record<string, string> = {
    "up": "arrowup", "down": "arrowdown", "left": "arrowleft", "right": "arrowright",
    "=": "=", "+": "=", "-": "-", "0": "0",
    "]": "]", "[": "[",
  };
  return map[key] ?? key;
}

export function matchesEvent(combo: KeyCombo, event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  const keyMatch = key === combo.key
    || (combo.key === "=" && (key === "=" || key === "+"));
  return keyMatch
    && event.metaKey === combo.cmd
    && event.shiftKey === combo.shift
    && event.ctrlKey === combo.ctrl
    && event.altKey === combo.alt;
}

interface Binding {
  combo: KeyCombo;
  comboStr: string;
  handler: ActionHandler;
}

export class KeybindingManager {
  private bindings = new Map<string, Binding>();

  register(action: string, comboStr: string, handler: ActionHandler): void {
    const combo = parseKeyCombo(comboStr);
    this.bindings.set(action, { combo, comboStr, handler });
  }

  updateFromConfig(keybindingConfig: Record<string, string>): void {
    for (const [action, comboStr] of Object.entries(keybindingConfig)) {
      const binding = this.bindings.get(action);
      if (binding) {
        binding.combo = parseKeyCombo(comboStr);
        binding.comboStr = comboStr;
      }
    }
  }

  handleKeyEvent(event: KeyboardEvent): boolean {
    for (const [, binding] of this.bindings) {
      if (matchesEvent(binding.combo, event)) {
        event.preventDefault();
        const result = binding.handler();
        if (result instanceof Promise) result.catch(console.error);
        return true;
      }
    }
    return false;
  }

  getAllBindings(): { action: string; comboStr: string }[] {
    return Array.from(this.bindings.entries()).map(([action, b]) => ({
      action,
      comboStr: b.comboStr,
    }));
  }

  static formatCombo(combo: string): string {
    return combo
      .replace(/cmd\+/gi, "⌘")
      .replace(/shift\+/gi, "⇧")
      .replace(/ctrl\+/gi, "⌃")
      .replace(/alt\+/gi, "⌥")
      .replace(/option\+/gi, "⌥")
      .replace(/up/gi, "↑")
      .replace(/down/gi, "↓")
      .toUpperCase();
  }
}
